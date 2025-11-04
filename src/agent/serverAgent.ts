import dotenv from 'dotenv';
import { ChaosChainSDK, NetworkConfig, AgentRole } from '@chaoschain/sdk';
import { Agent, MessageContext } from '@xmtp/agent-sdk';
import { createSigner, createUser } from '@xmtp/agent-sdk/user';
import { getTestUrl } from '@xmtp/agent-sdk/debug';
import { ethers } from 'ethers';
import chalk from 'chalk';
import ora from 'ora';
import {
  SwapRequest,
  SwapQuote,
  SwapAcceptance,
  SwapExecution,
  MESSAGE_TYPES,
  AgentConfig
} from '../../types/index';
import { UniswapV3Manager } from '../services/uniswap/uniswapV3';
import { UNISWAP_CFG } from '../services/uniswap/uniswap.config';
import { CustomPinataService } from '../services/customPinataService';
import { Mandate, caip10, addrFromCaip10 } from '../core/mandate';
import { SwapCore, SwapPayload } from '../../types/mandate';

dotenv.config();

class ServerAgent {
  private chaosSDK!: ChaosChainSDK;
  private xmtpAgent!: Agent;
  private agentId!: string;
  private config: AgentConfig;
  private uniswapManager?: UniswapV3Manager;
  private pinataService: CustomPinataService;
  private pendingRequests: Map<string, SwapRequest> = new Map();
  private pendingAcceptances: Map<string, SwapAcceptance> = new Map();
  private quoteIdToRequesterAddress: Map<string, string> = new Map();
  private dryRun: boolean;

  constructor(config: AgentConfig) {
    this.config = config;
    this.dryRun = process.env.UNISWAP_DRY_RUN === 'true' || process.env.UNISWAP_DRY_RUN === '1';

    // Initialize UniswapV3Manager only if not in dry run mode
    if (!this.dryRun && process.env.UNISWAP_PRIVATE_KEY) {
      try {
        this.uniswapManager = new UniswapV3Manager(process.env.UNISWAP_PRIVATE_KEY);
        console.log(chalk.green(`✅ UniswapV3Manager initialized (LIVE MODE)`));
      } catch (error) {
        console.warn(chalk.yellow(`⚠️  Failed to initialize UniswapV3Manager: ${error}. Falling back to dry run mode.`));
        this.dryRun = true;
      }
    } else {
      console.log(chalk.yellow(`⚠️  Running in DRY RUN mode (no actual swaps will be executed)`));
    }

    this.pinataService = new CustomPinataService({
      jwtToken: process.env.PINATA_JWT!,
      gatewayUrl: process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud'
    });
  }

  async initialize(): Promise<void> {
    const spinner = ora('Initializing Server Agent...').start();
    console.log('')
    try {
      // Initialize Chaos Chain SDK
      this.chaosSDK = new ChaosChainSDK({
        agentName: this.config.name,
        agentDomain: this.config.domain,
        agentRole: AgentRole.SERVER,
        network: this.config.network === 'sepolia' ? NetworkConfig.ETHEREUM_SEPOLIA : NetworkConfig.BASE_SEPOLIA,
        privateKey: this.config.privateKey,
        // enablePayments: true,
        //enableStorage: true
      });

      // Register on-chain identity
      const { agentId } = await this.chaosSDK.registerIdentity();
      this.agentId = agentId.toString();
      console.log(chalk.green(`✅ Server Agent registered on-chain with ID: ${this.agentId}`));

      // Initialize XMTP Agent (using same private key as Chaos SDK)
      const user = createUser(this.config.privateKey as `0x${string}`);
      const signer = createSigner(user);

      this.xmtpAgent = await Agent.create(signer, {
        env: this.config.network === 'sepolia' ? 'dev' : 'production',
        dbPath: (inboxId: string) => `${process.cwd()}/db/xmtp-dev-server-agent.db3`,
        dbEncryptionKey: process.env.XMTP_DB_ENCRYPTION_KEY as `0x${string}`,
      });

      // Set up message handlers
      this.setupMessageHandlers();

      spinner.succeed('Server Agent initialized successfully!');
      console.log(chalk.cyan(`🔗 XMTP URL: ${getTestUrl(this.xmtpAgent.client)}`));
      console.log(chalk.cyan(`📍 Server Agent Address: ${this.xmtpAgent.address}`));

    } catch (error) {
      spinner.fail('Failed to initialize Server Agent');
      console.error(chalk.red(`❌ Error: ${error}`));
      throw error;
    }
  }

  private setupMessageHandlers(): void {
    // Handle swap requests from Client Agent
    this.xmtpAgent.on('text', async (ctx) => {
      try {
        const message = JSON.parse(ctx.message.content);

        if (message.type === MESSAGE_TYPES.SWAP_REQUEST) {
          await this.handleSwapRequest(ctx, message.data);
        } else if (message.type === MESSAGE_TYPES.MANDATE_COUNTERSIGNED) {
          await this.handleCountersignedMandate(ctx, message.data);
        }
      } catch (error) {
        // Handle non-JSON messages or other errors
        console.log(chalk.gray(`📨 Received message: ${ctx.message.content}`));
      }
    });

    this.xmtpAgent.on('start', () => {
      console.log(chalk.green('🚀 Server Agent is online and ready!'));
    });
  }

  private async handleSwapRequest(ctx: any, request: SwapRequest): Promise<void> {
    console.log(chalk.yellow(`\n📥 Received swap request from Client Agent:`));
    console.log(chalk.gray(`   Request ID: ${request.id}`));
    console.log(chalk.gray(`   Amount: ${request.amount} ${request.fromToken}`));
    console.log(chalk.gray(`   Target: ${request.toToken}`));
    console.log(chalk.gray(`   Network: ${request.network}`));

    // Store the request
    this.pendingRequests.set(request.id, request);

    // Create and provide mandate with swap details
    await this.provideMandate(request, ctx);
  }

  private async handleCountersignedMandate(ctx: any, mandateJson: any): Promise<void> {
    console.log(chalk.green(`\n✅ Countersigned mandate received!`));
    const spinner = ora('Verifying countersigned mandate...').start();
    console.log('')

    try {
      // Reconstruct mandate from JSON
      const mandate = Mandate.fromObject(mandateJson);

      // Verify both signatures (client and server)
      mandate.verifyRole('client');
      mandate.verifyRole('server');

      console.log(chalk.green(`✅ Both signatures verified successfully!`));

      const mandateData = mandate.toJSON();
      console.log(chalk.gray(`   Mandate ID: ${mandateData.mandateId}`));
      console.log(chalk.gray(`   Intent: ${mandateData.intent}`));

      // Execute the swap using mandate ID
      spinner.succeed('Mandate verified and execution started');
      await this.executeSwapWithMandate(mandateData.mandateId, mandateData, ctx);
    } catch (error) {
      spinner.fail('Failed to verify mandate');
      console.error(chalk.red(`❌ Error: ${error}`));
    }
  }

  private async provideMandate(request: SwapRequest, ctx: any): Promise<void> {
    const spinner = ora('Creating mandate with swap details...').start();
    console.log('')
    try {
      // Get quote from Uniswap for mandate details
      const requesterAddress = (request as any).requesterAddress as string | undefined;
      if (!requesterAddress) {
        throw new Error('Requester address is required for mandate creation');
      }

      // Get quote (mock in dry run, actual in live mode)
      let uniswapQuote: any;
      if (this.dryRun || !this.uniswapManager) {
        // Mock quote for dry run
        uniswapQuote = {
          inputAmount: request.amount,
          outputAmount: (parseFloat(request.amount) * 0.0004).toFixed(6), // Mock exchange rate
          priceImpact: "0.12",
          gasEstimate: "0.001",
          route: [request.fromToken, request.toToken]
        };
        console.log(chalk.yellow(`   Using mock quote (DRY RUN)`));
      } else {
        // Get actual quote from Uniswap (would need to implement getQuote in UniswapV3Manager)
        // For now, use mock quote and log that real quote would be fetched
        uniswapQuote = {
          inputAmount: request.amount,
          outputAmount: (parseFloat(request.amount) * 0.0004).toFixed(6),
          priceImpact: "0.12",
          gasEstimate: "0.001",
          route: [request.fromToken, request.toToken]
        };
        console.log(chalk.blue(`   Note: Actual quote fetching not yet implemented, using estimate`));
      }

      // Get server wallet address (cast through unknown to HDNodeWallet)
      const serverWallet = new ethers.Wallet(this.config.privateKey) as unknown as ethers.HDNodeWallet;
      const serverAddress = serverWallet.address;
      const clientAddress = requesterAddress;

      // Determine chain ID based on network
      const chainId = request.network === 'sepolia' ? 11155111 : 1;

      // Create swap payload for mandate core
      const swapPayload: SwapPayload = {
        chainId,
        tokenIn: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC on mainnet (adjust for sepolia if needed)
        tokenOut: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC (adjust as needed)
        amountIn: (parseFloat(request.amount) * 1e6).toString(), // Convert to wei/units
        minOut: (parseFloat(uniswapQuote.outputAmount) * 0.99 * 1e18).toString(), // 1% slippage
        recipient: clientAddress,
        deadline: new Date(Date.now() + 15 * 60 * 1000).toISOString() // 15 minutes
      };

      // Create mandate
      const mandate = new Mandate({
        version: '0.1.0',
        client: caip10(chainId, clientAddress),
        server: caip10(chainId, serverAddress),
        deadline: new Date(Date.now() + 20 * 60 * 1000).toISOString(), // 20 minutes
        intent: `Swap ${request.amount} ${request.fromToken} for ${request.toToken} on ${request.network}`,
        core: {
          kind: 'swap@1',
          payload: swapPayload
        } as SwapCore
      });

      // Sign as server
      await mandate.signAsServer(serverWallet, 'eip191');

      // Store mandate ID to request mapping
      const mandateJson = mandate.toJSON();
      this.pendingRequests.set(mandateJson.mandateId, request);
      if (requesterAddress) {
        this.quoteIdToRequesterAddress.set(mandateJson.mandateId, requesterAddress);
      }

      // Send mandate to Client Agent
      await ctx.sendText(JSON.stringify({
        type: MESSAGE_TYPES.MANDATE,
        data: mandateJson
      }));

      spinner.succeed('Mandate created and sent to Client Agent!');
      console.log(chalk.blue(`📤 Sent mandate:`));
      console.log(chalk.gray(`   Mandate ID: ${mandateJson.mandateId}`));
      console.log(chalk.gray(`   Intent: ${mandateJson.intent}`));
      console.log(chalk.gray(`   Deadline: ${mandateJson.deadline}`));

    } catch (error) {
      spinner.fail('Failed to create mandate');
      console.error(chalk.red(`❌ Error: ${error}`));
    }
  }

  private async executeSwapWithMandate(mandateId: string, mandateJson: any, ctx: any): Promise<void> {
    const spinner = ora('Executing swap with verified mandate...').start();
    console.log('')
    try {
      // Extract swap details from mandate core
      const core = mandateJson.core as SwapCore;
      if (!core || core.kind !== 'swap@1') {
        throw new Error('Invalid mandate core: expected swap@1');
      }
      spinner.succeed('Swap execution started');
      const payload = core.payload;

      // Get the original request (stored by mandate ID)
      const originalRequest = this.pendingRequests.get(mandateId);
      if (!originalRequest) {
        throw new Error('Original request not found for mandate');
      }

      // Determine swap direction based on tokens
      const token0Symbol = UNISWAP_CFG.token0Symbol;
      const token1Symbol = UNISWAP_CFG.token1Symbol;
      const tokenInSymbol = originalRequest.fromToken;
      const tokenOutSymbol = originalRequest.toToken;

      // Determine if we're swapping token0 -> token1 or token1 -> token0
      const tokenInIs0 = tokenInSymbol === token0Symbol || tokenInSymbol === 'USDC';
      const amountIn = BigInt(payload.amountIn);

      let txHash: string;

      if (this.dryRun || !this.uniswapManager) {
        // DRY RUN: Generate mock transaction hash
        txHash = `0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`;
        console.log(chalk.yellow(`\n🧪 DRY RUN: Simulated swap execution`));
        console.log(chalk.gray(`   Mock TX Hash: ${txHash}`));
        console.log(chalk.gray(`   Amount In: ${ethers.formatUnits(amountIn, tokenInIs0 ? UNISWAP_CFG.token0Decimals : UNISWAP_CFG.token1Decimals)} ${tokenInSymbol}`));
      } else {
        // LIVE MODE: Execute actual swap
        console.log(chalk.green(`\n💱 Executing actual swap on Uniswap V3...`));

        try {
          // Execute the swap
          txHash = await this.uniswapManager.swap(tokenInIs0, amountIn);
          console.log(chalk.green(`✅ Swap transaction submitted: ${txHash}`));

          // Wait for transaction confirmation
          console.log(chalk.blue(`⏳ Waiting for transaction confirmation...`));
          await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds for confirmation
        } catch (error: any) {
          console.error(chalk.red(`❌ Swap execution failed: ${error.message}`));
          throw error;
        }
      }

      // Create proof object for IPFS (validation will be done by validator agent)
      const proof = {
        txHash,
        amountIn: amountIn.toString(),
        expectedTokenInIs0: tokenInIs0,
        tokenInSymbol,
        tokenOutSymbol,
        recipient: payload.recipient,
        dryRun: this.dryRun
      };

      // Store mandate and proof on IPFS
      const mandateCid = await this.pinataService.put(mandateJson, 'application/json');

      const proofData = {
        agentId: this.agentId,
        timestamp: Date.now(),
        result: `Swap executed successfully. TX: ${txHash}`,
        swapExecutionId: `execution_${Date.now()}`,
        mandateCid: mandateCid,
        txHash: txHash,
        swapDetails: {
          amountIn: proof.amountIn,
          expectedTokenInIs0: proof.expectedTokenInIs0,
          tokenInSymbol: proof.tokenInSymbol,
          tokenOutSymbol: proof.tokenOutSymbol,
          recipient: proof.recipient,
          dryRun: proof.dryRun
        },
        storedAt: Date.now(),
        storageProvider: 'pinata',
        version: '1.0.0'
      };

      const proofCid = await this.pinataService.put(proofData, 'application/json');

      // Optionally include feedback authorization
      let feedbackAuth: string | undefined = undefined;
      try {
        const requesterAddress = this.quoteIdToRequesterAddress.get(mandateId);
        if (requesterAddress) {
          const indexLimit = 1n;
          const expirySeconds = BigInt(Math.floor(Date.now() / 1000) + 60 * 60);
          feedbackAuth = await (this.chaosSDK as any).generateFeedbackAuthorization(
            BigInt(this.agentId),
            requesterAddress,
            indexLimit,
            expirySeconds
          );
        }
      } catch (e) {
        console.warn(chalk.yellow(`⚠️ Failed to generate feedback authorization: ${e}`));
      }

      const execution: SwapExecution = {
        id: `execution_${Date.now()}`,
        swapQuoteId: mandateId, // Using mandate ID as quote ID
        txHash,
        proofCid,
        status: 'success',
        timestamp: Date.now(),
        feedbackAuth
      };

      // Send execution result to Client Agent
      await ctx.sendText(JSON.stringify({
        type: MESSAGE_TYPES.SWAP_EXECUTION,
        data: execution
      }));

      spinner.succeed('Swap executed successfully!');
      console.log(chalk.green(`✅ Swap completed:`));
      console.log(chalk.gray(`   Transaction Hash: ${txHash}`));
      console.log(chalk.gray(`   Mandate CID: ${mandateCid}`));
      console.log(chalk.gray(`   Proof CID: ${proofCid}`));
      console.log(chalk.gray(`   Status: ${execution.status}`));
      console.log(chalk.gray(`   Mode: ${this.dryRun ? chalk.yellow('DRY RUN') : chalk.green('LIVE')}`));
      console.log(chalk.blue(`   Note: Transaction validation will be performed by Validator Agent`));

      // Request validation from validator with mandate and proof
      try {
        const validatorAddress = process.env.AGENT_VALIDATOR_ADDRESS!;
        if (!validatorAddress) {
          console.warn(chalk.yellow('VALIDATOR_ADDRESS not set. Skipping validation request.'));
        } else {
          // Create validation request payload that includes both mandate and proof
          const validationRequestPayload = {
            mandateCid: mandateCid,
            proofCid: proofCid,
            txHash: txHash,
            swapDetails: proof,
            timestamp: Date.now()
          };

          const requestCid = await this.pinataService.put(validationRequestPayload, 'application/json');
          const requestUri = `ipfs://${requestCid}`;

          // Compute request hash from validation request payload
          const { ethers } = await import('ethers');
          const requestHash = ethers.id(JSON.stringify(validationRequestPayload));

          await (this.chaosSDK as any).requestValidation(
            validatorAddress,
            BigInt(this.agentId),
            requestUri,
            requestHash
          );
          console.log(chalk.magenta('📝 Validation requested from validator (includes mandate and proof)'));
          console.log(chalk.green('🎉 Swap job completed, waiting for validation....'));
        }
      } catch (vErr) {
        console.error(chalk.red(`❌ Failed to request validation: ${vErr}`));
      }

    } catch (error) {
      spinner.fail('Failed to execute swap');
      console.error(chalk.red(`❌ Error: ${error}`));

      // Send failure notification
      const execution: SwapExecution = {
        id: `execution_${Date.now()}`,
        swapQuoteId: mandateId,
        txHash: '',
        proofCid: '',
        status: 'failed',
        timestamp: Date.now()
      };

      await ctx.sendText(JSON.stringify({
        type: MESSAGE_TYPES.SWAP_EXECUTION,
        data: execution
      }));
    }
  }

  async start(): Promise<void> {
    await this.xmtpAgent.start();
  }

  async stop(): Promise<void> {
    await this.xmtpAgent.stop();
  }
}

// Demo execution
async function runDemo() {
  console.log(chalk.bold.cyan('\n🤖 Server Agent - USDC to ETH Swap Provider\n'));

  const config: AgentConfig = {
    name: 'Server',
    domain: 'server.wachai.network',
    role: 'SERVER',
    privateKey: process.env.SERVER_AGENT_PRIVATE_KEY!,
    xmtpPrivateKey: process.env.SERVER_AGENT_PRIVATE_KEY!, // Use same key for both
    network: 'sepolia'
  };

  const serverAgent = new ServerAgent(config);

  try {
    await serverAgent.initialize();
    await serverAgent.start();

    console.log(chalk.cyan('\n🔄 Server Agent is running and waiting for swap requests. Press Ctrl+C to stop.'));

  } catch (error) {
    console.error(chalk.red(`❌ Demo failed: ${error}`));
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log(chalk.yellow('\n🛑 Shutting down Server Agent...'));
  process.exit(0);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  runDemo();
}

export { ServerAgent };


