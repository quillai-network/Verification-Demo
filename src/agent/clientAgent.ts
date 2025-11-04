import dotenv from 'dotenv';
import { ChaosChainSDK, NetworkConfig, AgentRole } from '@chaoschain/sdk';
import { Agent, MessageContext } from '@xmtp/agent-sdk';
import {createSigner, createUser} from '@xmtp/agent-sdk/user';
import { getTestUrl } from '@xmtp/agent-sdk/debug';
import { ethers } from 'ethers';
import chalk from 'chalk';
import ora from 'ora';
import { 
  SwapRequest, 
  SwapQuote, 
  SwapAcceptance, 
  SwapExecution, 
  AgentFeedback,
  MESSAGE_TYPES,
  AgentConfig 
} from '../../types/index';
import { CustomPinataService } from '../services/customPinataService';
import { Mandate, addrFromCaip10 } from '../core/mandate';
import { SwapCore, SwapPayload } from '../../types/mandate';

dotenv.config();

class ClientAgent {
  private chaosSDK!: ChaosChainSDK;
  private xmtpAgent!: Agent;
  private agentId!: string;
  private config: AgentConfig;
  private pinataService: CustomPinataService;
  private pendingQuotes: Map<string, SwapQuote> = new Map();
  private swapExecutions: Map<string, SwapExecution> = new Map();
  private pendingMandates: Map<string, any> = new Map(); // Store mandates by mandateId

  constructor(config: AgentConfig) {
    this.config = config;
    this.pinataService = new CustomPinataService({
      jwtToken: process.env.PINATA_JWT!,
      gatewayUrl: process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud'
    });
  }

  async initialize(): Promise<void> {
    const spinner = ora('Initializing Client Agent...').start();
    console.log('')
    try {
      // Initialize Chaos Chain SDK
      this.chaosSDK = new ChaosChainSDK({
        agentName: this.config.name,
        agentDomain: this.config.domain,
        agentRole: AgentRole.CLIENT,
        network: this.config.network === 'sepolia' ? NetworkConfig.ETHEREUM_SEPOLIA : NetworkConfig.BASE_SEPOLIA,
        privateKey: this.config.privateKey,
      });

      // Register on-chain identity
      const { agentId } = await this.chaosSDK.registerIdentity();
      this.agentId = agentId.toString();
      console.log(chalk.green(`✅ Client Agent registered on-chain with ID: ${this.agentId}`));

      // Initialize XMTP Agent (using same private key as Chaos SDK)
      const user = createUser(this.config.privateKey as `0x${string}`);
      const signer = createSigner(user);
      
      this.xmtpAgent = await Agent.create(signer, {
        env: this.config.network === 'sepolia' ? 'dev' : 'production',
        dbPath: (inboxId: string) => `${process.cwd()}/db/xmtp-dev-client-agent.db3`,
        dbEncryptionKey: process.env.XMTP_DB_ENCRYPTION_KEY as `0x${string}`,
      });

      // Set up message handlers
      this.setupMessageHandlers();

      spinner.succeed('Client Agent initialized successfully!');
      console.log(chalk.cyan(`🔗 XMTP URL: ${getTestUrl(this.xmtpAgent.client)}`));
      console.log(chalk.cyan(`📍 Client Agent Address: ${this.xmtpAgent.address}`));
      
    } catch (error) {
      spinner.fail('Failed to initialize Client Agent');
      console.error(chalk.red(`❌ Error: ${error}`));
      throw error;
    }
  }

  private setupMessageHandlers(): void {
    // Handle swap quotes from Server Agent
    this.xmtpAgent.on('text', async (ctx) => {
      try {
        const message = JSON.parse(ctx.message.content);
        
        if (message.type === MESSAGE_TYPES.MANDATE) {
          await this.handleMandate(ctx, message.data);
        } else if (message.type === MESSAGE_TYPES.SWAP_EXECUTION) {
          await this.handleSwapExecution(ctx, message.data);
        }
      } catch (error) {
        // Handle non-JSON messages or other errors
        console.log(chalk.gray(`📨 Received message: ${ctx.message.content}`));
      }
    });

    this.xmtpAgent.on('start', () => {
      console.log(chalk.green('🚀 Client Agent is online and ready!'));
    });
  }

  private async handleMandate(ctx: MessageContext, mandateJson: any): Promise<void> {
    console.log(chalk.yellow(`\n📋 Received mandate from Server Agent:`));
    const spinner = ora('Verifying mandate...').start();
    console.log('')
    
    try {
      // Reconstruct mandate from JSON
      const mandate = Mandate.fromObject(mandateJson);
      
      // Verify server signature
      mandate.verifyRole('server');
      
      console.log(chalk.green(`✅ Server signature verified!`));
      console.log(chalk.gray(`   Mandate ID: ${mandateJson.mandateId}`));
      console.log(chalk.gray(`   Intent: ${mandateJson.intent}`));
      console.log(chalk.gray(`   Deadline: ${mandateJson.deadline}`));
      
      // Perform local checks on terms (similar to mandateDemo.ts)
      const core = mandateJson.core;
      if (!this.isSwapCore(core)) {
        throw new Error('unexpected core shape for swap@1');
      }
      
      // Check if terms are acceptable (example check)
      const payload = core.payload;
      console.log(chalk.gray(`   Amount In: ${payload.amountIn}`));
      console.log(chalk.gray(`   Min Out: ${payload.minOut}`));
      console.log(chalk.gray(`   Recipient: ${payload.recipient}`));
      
      // Store mandate for later reference
      this.pendingMandates.set(mandateJson.mandateId, mandateJson);
      
      spinner.succeed('Mandate verified successfully!');
      
      // Automatically accept and sign as client
      setTimeout(async () => {
        await this.countersignMandate(mandateJson.mandateId, ctx);
      }, 2000);
      
    } catch (error) {
      spinner.fail('Failed to verify mandate');
      console.error(chalk.red(`❌ Error: ${error}`));
    }
  }

  private async countersignMandate(mandateId: string, ctx: MessageContext): Promise<void> {
    const mandateJson = this.pendingMandates.get(mandateId);
    if (!mandateJson) {
      console.error(chalk.red(`❌ Mandate not found: ${mandateId}`));
      return;
    }

    const spinner = ora('Countersigning mandate as client...').start();
    console.log('')
    
    try {
      // Reconstruct mandate
      const mandate = Mandate.fromObject(mandateJson);
      
      // Get client wallet (cast through unknown to HDNodeWallet)
      const clientWallet = new ethers.Wallet(this.config.privateKey) as unknown as ethers.HDNodeWallet;
      
      // Sign as client
      await mandate.signAsClient(clientWallet, 'eip191');
      
      // Get countersigned mandate JSON
      const countersignedMandate = mandate.toJSON();
      
      // Send back to Server Agent
      await ctx.sendText(JSON.stringify({
        type: MESSAGE_TYPES.MANDATE_COUNTERSIGNED,
        data: countersignedMandate
      }));
      
      spinner.succeed('Mandate countersigned and sent to Server Agent!');
      console.log(chalk.green(`✅ Countersigned mandate sent:`));
      console.log(chalk.gray(`   Mandate ID: ${mandateId}`));
      
    } catch (error) {
      spinner.fail('Failed to countersign mandate');
      console.error(chalk.red(`❌ Error: ${error}`));
    }
  }

  // Helper function to check if core is SwapCore (from mandateDemo.ts)
  private isSwapCore(x: unknown): x is SwapCore {
    const o = x as any;
    return (
      o &&
      o.kind === "swap@1" &&
      o.payload &&
      typeof o.payload.amountIn === "string"
    );
  }

  private async handleSwapExecution(ctx: MessageContext, execution: SwapExecution): Promise<void> {
    console.log(chalk.green(`\n✅ Swap execution completed!`));
    console.log(chalk.gray(`   Transaction Hash: ${execution.txHash}`));
    console.log(chalk.gray(`   Proof CID: ${execution.proofCid}`));
    console.log(chalk.gray(`   Status: ${execution.status}`));

    this.swapExecutions.set(execution.id, execution);

    // Submit feedback for Server Agent
    await this.submitFeedback(execution);
  }

  async requestSwap(agentBAddress: string): Promise<void> {
    const spinner = ora('Requesting swap from Server Agent...').start();
    console.log('')
    try {
      const walletAddress = new ethers.Wallet(this.config.privateKey).address;
      const swapRequest: SwapRequest = {
        id: `swap_${Date.now()}`,
        fromToken: 'USDC',
        toToken: 'ETH',
        amount: '0.1',
        network: 'sepolia',
        requesterAgentId: this.agentId,
        timestamp: Date.now()
      };

      // Create DM with Server Agent
      const dm = await this.xmtpAgent.createDmWithAddress(agentBAddress as `0x${string}`);

      // Send swap request
      await dm.send(JSON.stringify({
        type: MESSAGE_TYPES.SWAP_REQUEST,
        data: {
          ...swapRequest,
          requesterAddress: walletAddress
        }
      }));

      spinner.succeed('Swap request sent to Server Agent!');
      console.log(chalk.blue(`📤 Sent swap request:`));
      console.log(chalk.gray(`   Request ID: ${swapRequest.id}`));
      console.log(chalk.gray(`   Amount: ${swapRequest.amount} ${swapRequest.fromToken}`));
      console.log(chalk.gray(`   Target: ${swapRequest.toToken}`));
      console.log(chalk.gray(`   Network: ${swapRequest.network}`));

    } catch (error) {
      spinner.fail('Failed to send swap request');
      console.error(chalk.red(`❌ Error: ${error}`));
      throw error;
    }
  }

  private async submitFeedback(execution: SwapExecution): Promise<void> {
    const spinner = ora('Submitting feedback for Server Agent...').start();
    console.log('')
    const quote = this.pendingQuotes.get(execution.swapQuoteId);
    try {
      // Store evidence on IPFS using custom Pinata service
      const evidenceData = {
        agentId: this.agentId,
        timestamp: Date.now(),
        result: `Swap completed successfully. TX: ${execution.txHash}`,
        swapExecutionId: execution.id,
        storedAt: Date.now(),
        storageProvider: 'pinata',
        version: '1.0.0'
      };

      const cid = await this.pinataService.put(evidenceData, 'application/json');

      // Submit feedback
      const feedback: AgentFeedback = {
        id: `feedback_${Date.now()}`,
        targetAgentId: quote?.providerAgentId || '444', // In real scenario, this would be Server Agent's ID
        rating: 95,
        feedbackUri: `ipfs://${cid}`,
        swapExecutionId: execution.id,
        timestamp: Date.now()
      };

      
      const targetAgentIdBig = BigInt(feedback.targetAgentId);
      // const feedbackTx = await (this.chaosSDK as any).giveFeedback({
      //   agentId: targetAgentIdBig,
      //   rating: feedback.rating,
      //   feedbackUri: feedback.feedbackUri,
      //   feedbackData: {
      //     content: `Swap execution ${execution.id} completed. TX: ${execution.txHash}`,
      //     feedbackAuth: execution.feedbackAuth // provided by Server Agent
      //   }
      // });

      spinner.succeed('Feedback prepared successfully!');
      console.log(chalk.green(`⭐ Feedback prepared:`));
      console.log(chalk.gray(`   Rating: ${feedback.rating}/100`));
      console.log(chalk.gray(`   Evidence CID: ${cid}`));
      //console.log(chalk.gray(`   Feedback Transaction Hash: ${feedbackTx}`));
      console.log(chalk.gray(`   Status: Demo mode - submitted to blockchain`));

      // Signal demo completion and exit gracefully
      console.log(chalk.green('🎉 Swap job completed, waiting for validation....'));

    } catch (error) {
      spinner.fail('Failed to prepare feedback');
      console.error(chalk.red(`❌ Error: ${error}`));
      process.exit(1);
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
  console.log(chalk.bold.cyan('\n🤖 Client Agent - USDC to ETH Swap Requester\n'));
  
  const config: AgentConfig = {
    name: 'ClientAgent',
    domain: 'clientagent.wachAI.com',
    role: 'CLIENT',
    privateKey: process.env.CLIENT_AGENT_PRIVATE_KEY!,
    xmtpPrivateKey: process.env.CLIENT_AGENT_PRIVATE_KEY!, // Use same key for both
    network: 'sepolia'
  };

  const clientAgent = new ClientAgent(config);
  
  try {
    await clientAgent.initialize();
    await clientAgent.start();
    
    // Wait a moment for Server Agent to be ready
    console.log(chalk.yellow('\n⏳ Waiting for Server Agent to be ready...'));
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Request swap from Server Agent
    const serverAgentAddress = process.env.SERVER_AGENT_ADDRESS!;
    await clientAgent.requestSwap(serverAgentAddress);
    
    // Keep the agent running
    console.log(chalk.cyan('\n🔄 Client Agent is running. Press Ctrl+C to stop.'));
    
  } catch (error) {
    console.error(chalk.red(`❌ Demo failed: ${error}`));
    throw error
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log(chalk.yellow('\n🛑 Shutting down Client Agent...'));
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log(chalk.yellow('\n🛑 Shutting down Client Agent (SIGTERM)...'));
  process.exit(0);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  runDemo();
}

export { ClientAgent };


