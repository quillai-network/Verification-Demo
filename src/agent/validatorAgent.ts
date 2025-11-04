import dotenv from 'dotenv';
import { ChaosChainSDK, NetworkConfig, AgentRole } from '@chaoschain/sdk';
import { ethers } from 'ethers';
import chalk from 'chalk';
import ora from 'ora';
import { CustomPinataService } from '../services/customPinataService';
import { verifyMandateAsThirdParty } from './verifier/thirdParty';
import { UniswapV3Manager, SwapValidationResult } from '../services/uniswap/uniswapV3';
import { UNISWAP_CFG } from '../services/uniswap/uniswap.config';

dotenv.config();

class ValidatorAgent {
  private chaosSDK!: ChaosChainSDK;
  private validatorAgentId!: string;
  private pinataService: CustomPinataService;
  private uniswapManager?: UniswapV3Manager;

  constructor() {
    this.pinataService = new CustomPinataService({
      jwtToken: process.env.PINATA_JWT!,
      gatewayUrl: process.env.PINATA_GATEWAY || 'https://gateway.pinata.cloud'
    });

    // Initialize UniswapV3Manager for transaction validation
    if (process.env.AGENT_VALIDATOR_PRIVATE_KEY) {
      try {
        this.uniswapManager = new UniswapV3Manager(process.env.AGENT_VALIDATOR_PRIVATE_KEY);
        console.log(chalk.green(`✅ UniswapV3Manager initialized for validation`));
      } catch (error) {
        console.warn(chalk.yellow(`⚠️  Failed to initialize UniswapV3Manager: ${error}. Transaction validation will be skipped.`));
      }
    }
  }

  async initialize(): Promise<void> {
    const spinner = ora('Initializing Validator Agent...').start();
    console.log('')
    try {
      this.chaosSDK = new ChaosChainSDK({
        agentName: 'ValidatorAgent',
        agentDomain: 'validator.example.com',
        // Using SERVER role for compatibility; SDK may expose a VALIDATOR role.
        agentRole: AgentRole.VALIDATOR,
        network: (process.env.NETWORK === 'sepolia') ? NetworkConfig.ETHEREUM_SEPOLIA : NetworkConfig.BASE_SEPOLIA,
        privateKey: process.env.AGENT_VALIDATOR_PRIVATE_KEY!,
        // enablePayments: false,
        // enableStorage: true,
      });

      const { agentId } = await this.chaosSDK.registerIdentity();
      this.validatorAgentId = agentId.toString();
      spinner.succeed('Validator Agent initialized');
      console.log(chalk.green(`✅ Validator registered with ID: ${this.validatorAgentId}`));

      this.setupValidationListener();
    } catch (error) {
      spinner.fail('Failed to initialize Validator Agent');
      console.error(chalk.red(`❌ Error: ${error}`));
      throw error;
    }
  }

  private setupValidationListener(): void {
    // Subscribe to on-chain ValidationRequest events
    ((this.chaosSDK as any).chaosAgent as any).onValidationRequest(async (...args: any[]) => {
      // Ethers event callback signature: (...eventArgs, event)
      // Try to locate fields by type/shape
      const flatArgs = args || [];
      const eventObj = flatArgs[flatArgs.length - 1];
      // Heuristics to extract values
      const requestHash = flatArgs.find((a: any) => typeof a === 'string' && /^0x[0-9a-fA-F]{64}$/.test(a));
      const requestUri = flatArgs.find((a: any) => typeof a === 'string' && /^ipfs:\/\//.test(a) || /^https?:\/\//.test(a));

      console.log(chalk.cyan('\n🧭 New ValidationRequest event'));
      console.log(chalk.gray(`   requestHash: ${requestHash || 'unknown'}`));
      console.log(chalk.gray(`   requestUri: ${requestUri || 'unknown'}`));

      try {
        const spinner = ora('Loading validation request from IPFS...').start();
        console.log('')
        
        // Load validation request from IPFS
        if (!requestUri || !requestUri.startsWith('ipfs://')) {
          throw new Error('Invalid request URI: must be an IPFS URI');
        }
        
        const ipfsHash = requestUri.replace('ipfs://', '');
        const validationRequestData = await this.pinataService.get(ipfsHash);
        
        if (!validationRequestData) {
          throw new Error('Failed to load validation request from IPFS');
        }
        
        spinner.text = 'Loading mandate from IPFS...';
        
        // Extract mandate CID from validation request
        const mandateCid = validationRequestData.mandateCid;
        if (!mandateCid) {
          throw new Error('Mandate CID not found in validation request');
        }
        
        // Load actual mandate JSON using the mandate CID
        const mandateJson = await this.pinataService.get(mandateCid);
        
        if (!mandateJson) {
          throw new Error('Failed to load mandate from IPFS');
        }
        
        // Verify mandate has required fields
        if (!mandateJson.client || !mandateJson.server) {
          throw new Error('Mandate missing required client or server fields (CAIP-10)');
        }
        
        spinner.succeed('Mandate and validation request loaded from IPFS');
        console.log(chalk.cyan(`📋 Verifying mandate as third party...`));
        
        // Verify mandate as third party
        const verificationResult = verifyMandateAsThirdParty(mandateJson, {
          primitive: 'swap@1',
          // Optional: add requireClient/requireServer if needed
        });
        
        console.log(chalk.green(`✅ Mandate verification successful!`));
        console.log(chalk.gray(`   Mandate Hash: ${verificationResult.mandateHash}`));
        console.log(chalk.gray(`   Client: ${verificationResult.parties.client}`));
        console.log(chalk.gray(`   Server: ${verificationResult.parties.server}`));
        console.log(chalk.gray(`   Client Signature: ${verificationResult.signatures.client.ok ? '✅ Valid' : '❌ Invalid'}`));
        console.log(chalk.gray(`   Server Signature: ${verificationResult.signatures.server.ok ? '✅ Valid' : '❌ Invalid'}`));
        
        // Determine validation score based on mandate verification
        let responseScore = 100;
        if (!verificationResult.ok) {
          responseScore = 0;
        } else if (!verificationResult.signatures.client.ok || !verificationResult.signatures.server.ok) {
          responseScore = 50;
        }
        
        // Validate mandate deadline
        const mandateDeadline = new Date(mandateJson.deadline).getTime();
        const now = Date.now();
        if (now > mandateDeadline) {
          console.log(chalk.yellow(`⚠️  Mandate deadline has passed`));
          responseScore = Math.max(0, responseScore - 20);
        }

        // Validate swap transaction using proof CID from validation request
        let swapValidationResult: SwapValidationResult | null = null;
        
        // validationRequestData was already loaded above, now use proofCid from it
        if (validationRequestData && validationRequestData.proofCid && this.uniswapManager) {
          console.log(chalk.blue(`\n🔍 Validating swap transaction from proof data...`));
          
          try {
            // Load proof data containing transaction hash
            const proofData = await this.pinataService.get(validationRequestData.proofCid);
            
            if (proofData && proofData.txHash) {
              const core = mandateJson.core;
              if (core && core.kind === 'swap@1') {
                const payload = core.payload;
                const swapDetails = proofData.swapDetails || validationRequestData.swapDetails;
                
                if (swapDetails) {
                  const amountIn = BigInt(swapDetails.amountIn || payload.amountIn);
                  const tokenInIs0 = swapDetails.expectedTokenInIs0 !== undefined 
                    ? swapDetails.expectedTokenInIs0
                    : (payload.tokenIn?.toLowerCase() === UNISWAP_CFG.token0.toLowerCase());
                  
                  spinner.text = 'Validating transaction on-chain...';
                  
                  // Validate the swap transaction
                  swapValidationResult = await this.uniswapManager.validateSwap(
                    proofData.txHash,
                    amountIn,
                    undefined,
                    tokenInIs0
                  );
                  
                  if (swapValidationResult.isValid) {
                    console.log(chalk.green(`✅ Swap transaction validation passed!`));
                    console.log(chalk.gray(`   Amount In: ${ethers.formatUnits(swapValidationResult.amountIn, tokenInIs0 ? UNISWAP_CFG.token0Decimals : UNISWAP_CFG.token1Decimals)}`));
                    console.log(chalk.gray(`   Amount Out: ${ethers.formatUnits(swapValidationResult.amountOut, tokenInIs0 ? UNISWAP_CFG.token1Decimals : UNISWAP_CFG.token0Decimals)}`));
                  } else {
                    console.log(chalk.red(`❌ Swap transaction validation failed!`));
                    swapValidationResult.errors?.forEach(err => console.log(chalk.red(`   - ${err}`)));
                    // Reduce score based on validation failures
                    responseScore = Math.max(0, responseScore - 30);
                  }
                } else {
                  console.log(chalk.yellow(`⚠️  Swap details not found in proof data`));
                }
              }
            } else {
              console.log(chalk.yellow(`⚠️  Transaction hash not found in proof data (dry run mode?)`));
            }
          } catch (validationError: any) {
            console.error(chalk.yellow(`⚠️  Failed to validate swap transaction: ${validationError.message}`));
            // Don't fail completely, but note it
            responseScore = Math.max(0, responseScore - 10);
          }
        } else if (!this.uniswapManager) {
          console.log(chalk.yellow(`⚠️  UniswapV3Manager not initialized - skipping transaction validation`));
        }

        // Attach validator notes with verification details
        const notes = {
          validatorAgentId: this.validatorAgentId,
          receivedAt: Date.now(),
          decisionScore: responseScore,
          requestHash,
          requestUri,
          mandateHash: verificationResult.mandateHash,
          verificationResult: {
            ok: verificationResult.ok,
            parties: verificationResult.parties,
            clientSignatureValid: verificationResult.signatures.client.ok,
            serverSignatureValid: verificationResult.signatures.server.ok,
          },
          swapValidation: swapValidationResult ? {
            isValid: swapValidationResult.isValid,
            transactionHash: swapValidationResult.transactionHash,
            amountIn: swapValidationResult.amountIn.toString(),
            amountOut: swapValidationResult.amountOut.toString(),
            errors: swapValidationResult.errors,
            warnings: swapValidationResult.warnings
          } : null,
          version: '1.0.0'
        };
        const cid = await this.pinataService.put(notes, 'application/json');
        const feedbackUri = `ipfs://${cid}`;

        // Derive a simple response hash from the feedback URI
        const responseHash = ethers.id(feedbackUri);

        console.log(chalk.magenta(`\n📤 Submitting Validation On-chain`));
        console.log(chalk.magenta(`   requestHash: ${requestHash}`));
        console.log(chalk.magenta(`   responseScore: ${responseScore}`));
        console.log(chalk.magenta(`   feedbackUri: ${feedbackUri}`));
        console.log(chalk.magenta(`   responseHash: ${responseHash}`));
        
        const tx = await (this.chaosSDK as any).respondToValidation(
          requestHash,
          responseScore,
          feedbackUri,
          responseHash
        );
        
        console.log(chalk.greenBright(`   Transaction: https://sepolia.etherscan.io/tx/${tx.hash}`));
        console.log(chalk.green('\n✅ Validation response sent on-chain'));
        console.log(chalk.green('🎉 Demo completed! Please close all agents to end the demo.'));
      } catch (err) {
        console.error(chalk.red(`❌ Validation handling error: ${err}`));
         process.exit(1);
      }
    });
  }
}

async function run() {
  console.log(chalk.bold.cyan('\n🛡️  Validator Agent'));
  const agent = new ValidatorAgent();
  await agent.initialize();
  console.log(chalk.cyan('\n🔄 Validator Agent is running. Press Ctrl+C to stop.'));
}

process.on('SIGINT', async () => {
  console.log(chalk.yellow('\n🛑 Shutting down Validator Agent...'));
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log(chalk.yellow('\n🛑 Shutting down Validator Agent (SIGTERM)...'));
  process.exit(0);
});

if (import.meta.url === `file://${process.argv[1]}`) {
  run();
}

export { ValidatorAgent };


