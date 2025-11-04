import dotenv from 'dotenv';
import { ethers } from 'ethers';
import chalk from 'chalk';
import ora from 'ora';

dotenv.config();

// Validation Contract ABI - only the validationResponse function
const VALIDATION_CONTRACT_ABI = [
  {
    inputs: [
      { internalType: "bytes32", name: "requestHash", type: "bytes32" },
      { internalType: "uint8", name: "response", type: "uint8" },
      { internalType: "string", name: "responseUri", type: "string" },
      { internalType: "bytes32", name: "responseHash", type: "bytes32" },
      { internalType: "bytes32", name: "tag", type: "bytes32" }
    ],
    name: "validationResponse",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function"
  },
  {
    inputs: [
      { internalType: "bytes32", name: "requestHash", type: "bytes32" }
    ],
    name: "getValidationStatus",
    outputs: [
      { internalType: "address", name: "validatorAddress", type: "address" },
      { internalType: "uint256", name: "agentId", type: "uint256" },
      { internalType: "uint8", name: "response", type: "uint8" },
      { internalType: "bytes32", name: "responseHash", type: "bytes32" },
      { internalType: "bytes32", name: "tag", type: "bytes32" },
      { internalType: "uint256", name: "lastUpdate", type: "uint256" }
    ],
    stateMutability: "view",
    type: "function"
  }
];

// Contract address on Sepolia
const VALIDATION_CONTRACT_ADDRESS = "0x8004CB39f29c09145F24Ad9dDe2A108C1A2cdfC5";

// Test values from your terminal
const TEST_VALUES = {
  requestHash: "0xb0b17c569bebf450dd3e576b32bce106463750348ecfed537ffe702229d30f8a",
  responseScore: 100, // uint8 (0-255, but typically 0-100 for validation)
  feedbackUri: "ipfs://QmQhzqCPVgusJeRGCUUwLRXy14kd8LmFPMaNeRncAGBRK7",
  responseHash: "0xcb39713849f12085aa5bee76bfae9207bf28840ced073423fff8954a9f44995c",
  tag: ethers.ZeroHash // Empty tag (32 zero bytes)
};

async function testValidationResponse() {
  const spinner = ora('Initializing test...').start();
  
  try {
    // Get RPC URL - try environment variable or use public Sepolia endpoint
    const rpcUrl = process.env.ETHEREUM_SEPOLIA_RPC_URL || "https://rpc.sepolia.org";
    
    // Get validator private key from environment
    const privateKey = process.env.AGENT_VALIDATOR_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error("AGENT_VALIDATOR_PRIVATE_KEY not found in environment");
    }

    spinner.text = "Connecting to Sepolia network...";
    
    // Setup provider and wallet
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);
    
    const address = await wallet.getAddress();
    const balance = await provider.getBalance(address);
    
    spinner.succeed("Connected to network");
    console.log(chalk.blue(`\n📋 Test Configuration:`));
    console.log(chalk.gray(`   Contract: ${VALIDATION_CONTRACT_ADDRESS}`));
    console.log(chalk.gray(`   Network: Sepolia`));
    console.log(chalk.gray(`   Validator: ${address}`));
    console.log(chalk.gray(`   Balance: ${ethers.formatEther(balance)} ETH`));
    
    if (balance === 0n) {
      console.error(chalk.red(`\n❌ Error: Validator has zero ETH balance. Cannot send transaction.`));
      process.exit(1);
    }

    // Create contract instance
    spinner.start("Creating contract instance...");
    const contract = new ethers.Contract(
      VALIDATION_CONTRACT_ADDRESS,
      VALIDATION_CONTRACT_ABI,
      wallet
    );

    // Check validation status before submitting
    spinner.text = "Checking current validation status...";
    try {
      const status = await contract.getValidationStatus(TEST_VALUES.requestHash);
      console.log(chalk.yellow(`\n📊 Current Validation Status:`));
      console.log(chalk.gray(`   Validator: ${status.validatorAddress}`));
      console.log(chalk.gray(`   Agent ID: ${status.agentId.toString()}`));
      console.log(chalk.gray(`   Response: ${status.response.toString()}`));
      console.log(chalk.gray(`   Response Hash: ${status.responseHash}`));
      console.log(chalk.gray(`   Last Update: ${new Date(Number(status.lastUpdate) * 1000).toISOString()}`));
      
      if (status.response > 0) {
        console.log(chalk.yellow(`\n⚠️  Warning: Validation already has a response (${status.response}). This will update it.`));
      }
    } catch (error: any) {
      if (error.message?.includes("execution reverted")) {
        console.log(chalk.blue(`\nℹ️  Validation request exists but no response yet.`));
      } else {
        console.log(chalk.yellow(`\n⚠️  Could not check status: ${error.message}`));
      }
    }

    // Prepare transaction parameters
    console.log(chalk.magenta(`\n📤 Submitting Validation Response:`));
    console.log(chalk.gray(`   Request Hash: ${TEST_VALUES.requestHash}`));
    console.log(chalk.gray(`   Response Score: ${TEST_VALUES.responseScore}`));
    console.log(chalk.gray(`   Feedback URI: ${TEST_VALUES.feedbackUri}`));
    console.log(chalk.gray(`   Response Hash: ${TEST_VALUES.responseHash}`));
    console.log(chalk.gray(`   Tag: ${TEST_VALUES.tag}`));

    // Estimate gas first
    spinner.text = "Estimating gas...";
    let gasEstimate: bigint;
    try {
      gasEstimate = await contract.validationResponse.estimateGas(
        TEST_VALUES.requestHash,
        TEST_VALUES.responseScore,
        TEST_VALUES.feedbackUri,
        TEST_VALUES.responseHash,
        TEST_VALUES.tag
      );
      console.log(chalk.blue(`   Estimated Gas: ${gasEstimate.toString()}`));
    } catch (error: any) {
      console.error(chalk.red(`\n❌ Gas estimation failed:`));
      console.error(chalk.red(`   ${error.message || error}`));
      
      // Try to get more details
      if (error.data) {
        console.error(chalk.red(`   Data: ${error.data}`));
      }
      if (error.reason) {
        console.error(chalk.red(`   Reason: ${error.reason}`));
      }
      
      console.log(chalk.yellow(`\n💡 Possible issues:`));
      console.log(chalk.yellow(`   1. Request hash doesn't exist or already has a response`));
      console.log(chalk.yellow(`   2. Validator address doesn't match the request`));
      console.log(chalk.yellow(`   3. Invalid parameters format`));
      console.log(chalk.yellow(`   4. Contract access control/permissions issue`));
      
      process.exit(1);
    }

    // Submit transaction
    spinner.text = "Submitting transaction...";
    const tx = await contract.validationResponse(
      TEST_VALUES.requestHash,
      TEST_VALUES.responseScore,
      TEST_VALUES.feedbackUri,
      TEST_VALUES.responseHash,
      TEST_VALUES.tag,
      {
        gasLimit: gasEstimate * 120n / 100n // Add 20% buffer
      }
    );

    console.log(chalk.cyan(`\n⏳ Transaction sent!`));
    console.log(chalk.gray(`   Transaction Hash: ${tx.hash}`));
    console.log(chalk.gray(`   Waiting for confirmation...`));

    spinner.text = "Waiting for transaction confirmation...";
    const receipt = await tx.wait();

    if (receipt && receipt.status === 1) {
      spinner.succeed("Transaction confirmed!");
      console.log(chalk.green(`\n✅ Validation Response Submitted Successfully!`));
      console.log(chalk.gray(`   Transaction Hash: ${receipt.hash}`));
      console.log(chalk.gray(`   Block Number: ${receipt.blockNumber}`));
      console.log(chalk.gray(`   Gas Used: ${receipt.gasUsed.toString()}`));
      
      // Verify the response was recorded
      spinner.start("Verifying validation response...");
      const newStatus = await contract.getValidationStatus(TEST_VALUES.requestHash);
      spinner.succeed("Response verified!");
      
      console.log(chalk.green(`\n📊 Updated Validation Status:`));
      console.log(chalk.gray(`   Validator: ${newStatus.validatorAddress}`));
      console.log(chalk.gray(`   Agent ID: ${newStatus.agentId.toString()}`));
      console.log(chalk.gray(`   Response: ${newStatus.response.toString()}`));
      console.log(chalk.gray(`   Response Hash: ${newStatus.responseHash}`));
      console.log(chalk.gray(`   Last Update: ${new Date(Number(newStatus.lastUpdate) * 1000).toISOString()}`));
      
      if (newStatus.response.toString() === TEST_VALUES.responseScore.toString() && 
          newStatus.responseHash.toLowerCase() === TEST_VALUES.responseHash.toLowerCase()) {
        console.log(chalk.green(`\n✅ Response matches submitted values!`));
      }
      
      console.log(chalk.cyan(`\n🔗 View on Etherscan:`));
      console.log(chalk.blue(`   https://sepolia.etherscan.io/tx/${receipt.hash}`));
      
    } else {
      spinner.fail("Transaction failed!");
      console.error(chalk.red(`\n❌ Transaction reverted!`));
      if (receipt) {
        console.error(chalk.red(`   Status: ${receipt.status}`));
        console.error(chalk.red(`   Gas Used: ${receipt.gasUsed.toString()}`));
      }
      process.exit(1);
    }

  } catch (error: any) {
    spinner.fail("Test failed");
    console.error(chalk.red(`\n❌ Error:`));
    console.error(chalk.red(`   ${error.message || error}`));
    
    if (error.transaction) {
      console.error(chalk.red(`\n   Transaction: ${JSON.stringify(error.transaction, null, 2)}`));
    }
    if (error.receipt) {
      console.error(chalk.red(`   Receipt: ${JSON.stringify(error.receipt, null, 2)}`));
    }
    if (error.reason) {
      console.error(chalk.red(`   Reason: ${error.reason}`));
    }
    if (error.data) {
      console.error(chalk.red(`   Data: ${error.data}`));
    }
    
    // Check for common errors
    if (error.code === 'INSUFFICIENT_FUNDS') {
      console.error(chalk.yellow(`\n💡 Insufficient funds for gas. Please add ETH to ${await new ethers.Wallet(process.env.AGENT_VALIDATOR_PRIVATE_KEY!).getAddress()}`));
    }
    
    process.exit(1);
  }
}

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  testValidationResponse().catch(console.error);
}

export { testValidationResponse };

