import dotenv from "dotenv";
import { ethers } from "ethers";
import chalk from "chalk";
import ora from "ora";
import { UniswapV3Manager } from "../src/services/uniswap/uniswapV3.js";
import { UNISWAP_CFG } from "../src/services/uniswap/uniswap.config.js";

dotenv.config();

/**
 * Test script for Uniswap V3 token swapping
 * 
 * This script tests the swap functionality by:
 * 1. Checking initial balances
 * 2. Executing a swap
 * 3. Checking final balances
 * 4. Displaying the results
 */
async function testSwap() {
  const spinner = ora("Initializing swap test...").start();

  try {
    // Validate required environment variables
    if (!process.env.UNISWAP_PRIVATE_KEY) {
      throw new Error("UNISWAP_PRIVATE_KEY environment variable is required");
    }

    if (!process.env.ETHEREUM_SEPOLIA_RPC_URL) {
      throw new Error("ETHEREUM_SEPOLIA_RPC_URL environment variable is required");
    }

    if (!process.env.UNISWAP_V3_SWAP_ROUTER) {
      throw new Error("UNISWAP_V3_SWAP_ROUTER environment variable is required");
    }

    spinner.succeed("Environment variables validated");

    // Initialize Uniswap V3 Manager
    spinner.start("Creating UniswapV3Manager instance...");
    const manager = new UniswapV3Manager(process.env.UNISWAP_PRIVATE_KEY);
    // Get wallet address from private key
    const rpcUrl = process.env.ETHEREUM_SEPOLIA_RPC_URL!;
    const provider = new ethers.JsonRpcProvider(
      rpcUrl,
      UNISWAP_CFG.chainId
    );
    const wallet = new ethers.Wallet(
      process.env.UNISWAP_PRIVATE_KEY,
      provider
    );
    const walletAddress = await wallet.getAddress();
    spinner.succeed(`UniswapV3Manager created for wallet: ${walletAddress}`);

    // Display configuration
    console.log(chalk.blue("\n📋 Swap Configuration:"));
    console.log(chalk.gray(`   Token 0: ${UNISWAP_CFG.token0Symbol} (${UNISWAP_CFG.token0})`));
    console.log(chalk.gray(`   Token 1: ${UNISWAP_CFG.token1Symbol} (${UNISWAP_CFG.token1})`));
    console.log(chalk.gray(`   Fee Tier: ${UNISWAP_CFG.fee / 10000}%`));
    console.log(chalk.gray(`   Chain ID: ${UNISWAP_CFG.chainId}`));

    // Get initial balances
    spinner.start("Fetching initial balances...");
    const balancesBefore = await manager.getBalances();
    spinner.succeed("Initial balances fetched");

    console.log(chalk.blue("\n💰 Initial Balances:"));
    const token0Before = ethers.formatUnits(
      balancesBefore.token0,
      UNISWAP_CFG.token0Decimals
    );
    const token1Before = ethers.formatUnits(
      balancesBefore.token1,
      UNISWAP_CFG.token1Decimals
    );
    console.log(
      chalk.gray(
        `   ${UNISWAP_CFG.token0Symbol}: ${token0Before} (${balancesBefore.token0.toString()} wei)`
      )
    );
    console.log(
      chalk.gray(
        `   ${UNISWAP_CFG.token1Symbol}: ${token1Before} (${balancesBefore.token1.toString()} wei)`
      )
    );

    // Determine swap direction based on available balances
    // Swap token0 -> token1 if we have token0, otherwise swap token1 -> token0
    const hasToken0 = balancesBefore.token0 > 0n;
    const hasToken1 = balancesBefore.token1 > 0n;

    if (!hasToken0 && !hasToken1) {
      throw new Error(
        `Insufficient balance: No tokens available. Need ${UNISWAP_CFG.token0Symbol} or ${UNISWAP_CFG.token1Symbol} to swap.`
      );
    }

    // Determine swap amount (swap 10% of available balance or a minimum amount)
    const tokenInIs0 = hasToken0;
    const availableBalance = tokenInIs0
      ? balancesBefore.token0
      : balancesBefore.token1;
    const decimals = tokenInIs0
      ? UNISWAP_CFG.token0Decimals
      : UNISWAP_CFG.token1Decimals;
    const symbol = tokenInIs0
      ? UNISWAP_CFG.token0Symbol
      : UNISWAP_CFG.token1Symbol;

    // Swap 10% of available balance, but at least 0.1 tokens (in human-readable units)
    const minSwapAmount = ethers.parseUnits("0.1", decimals);
    const swapAmount = minSwapAmount

    // Ensure we don't swap more than available
    if (swapAmount > availableBalance) {
      throw new Error(
        `Insufficient balance: Trying to swap ${ethers.formatUnits(swapAmount, decimals)} ${symbol}, but only have ${ethers.formatUnits(availableBalance, decimals)}`
      );
    }

    console.log(chalk.blue("\n💱 Swap Details:"));
    console.log(
      chalk.gray(
        `   Direction: ${symbol} -> ${tokenInIs0 ? UNISWAP_CFG.token1Symbol : UNISWAP_CFG.token0Symbol}`
      )
    );
    console.log(
      chalk.gray(
        `   Amount: ${ethers.formatUnits(swapAmount, decimals)} ${symbol}`
      )
    );

    // Execute swap
    spinner.start(`Executing swap: ${symbol} -> ${tokenInIs0 ? UNISWAP_CFG.token1Symbol : UNISWAP_CFG.token0Symbol}...`);
    const txHash = await manager.swap(tokenInIs0, swapAmount);
    spinner.succeed(`Swap transaction confirmed! Hash: ${txHash}`);
    
    console.log(chalk.blue(`\n🔗 Transaction Hash: ${txHash}`));

    // Validate the swap transaction
    spinner.start("Validating swap transaction...");
    const validationResult = await manager.validateSwap(
      txHash,
      swapAmount, // Expected amount in
      undefined,  // Amount out (will be validated with 1% tolerance)
      tokenInIs0  // Expected swap direction
    );
    
    if (validationResult.isValid) {
      spinner.succeed("Swap validation passed!");
    } else {
      spinner.warn("Swap validation completed with issues");
    }

    console.log(chalk.blue("\n🔍 Swap Validation Results:"));
    console.log(chalk.gray(`   Valid: ${validationResult.isValid ? chalk.green("✓") : chalk.red("✗")}`));
    console.log(chalk.gray(`   Block Number: ${validationResult.blockNumber}`));
    console.log(chalk.gray(`   Pool Address: ${validationResult.poolAddress}`));
    console.log(chalk.gray(`   Recipient: ${validationResult.recipient}`));
    console.log(
      chalk.gray(
        `   Direction: ${validationResult.tokenInIs0 ? UNISWAP_CFG.token0Symbol : UNISWAP_CFG.token1Symbol} -> ${validationResult.tokenInIs0 ? UNISWAP_CFG.token1Symbol : UNISWAP_CFG.token0Symbol}`
      )
    );
    console.log(
      chalk.gray(
        `   Amount In: ${ethers.formatUnits(validationResult.amountIn, validationResult.tokenInIs0 ? UNISWAP_CFG.token0Decimals : UNISWAP_CFG.token1Decimals)} ${validationResult.tokenInIs0 ? UNISWAP_CFG.token0Symbol : UNISWAP_CFG.token1Symbol}`
      )
    );
    console.log(
      chalk.gray(
        `   Amount Out: ${ethers.formatUnits(validationResult.amountOut, validationResult.tokenInIs0 ? UNISWAP_CFG.token1Decimals : UNISWAP_CFG.token0Decimals)} ${validationResult.tokenInIs0 ? UNISWAP_CFG.token1Symbol : UNISWAP_CFG.token0Symbol}`
      )
    );

    if (validationResult.errors && validationResult.errors.length > 0) {
      console.log(chalk.red("\n❌ Validation Errors:"));
      validationResult.errors.forEach((error) => {
        console.log(chalk.red(`   - ${error}`));
      });
    }

    if (validationResult.warnings && validationResult.warnings.length > 0) {
      console.log(chalk.yellow("\n⚠️  Validation Warnings:"));
      validationResult.warnings.forEach((warning) => {
        console.log(chalk.yellow(`   - ${warning}`));
      });
    }

    // Wait a moment for state to update
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Get final balances
    spinner.start("Fetching final balances...");
    const balancesAfter = await manager.getBalances();
    spinner.succeed("Final balances fetched");

    console.log(chalk.blue("\n💰 Final Balances:"));
    const token0After = ethers.formatUnits(
      balancesAfter.token0,
      UNISWAP_CFG.token0Decimals
    );
    const token1After = ethers.formatUnits(
      balancesAfter.token1,
      UNISWAP_CFG.token1Decimals
    );
    console.log(
      chalk.gray(
        `   ${UNISWAP_CFG.token0Symbol}: ${token0After} (${balancesAfter.token0.toString()} wei)`
      )
    );
    console.log(
      chalk.gray(
        `   ${UNISWAP_CFG.token1Symbol}: ${token1After} (${balancesAfter.token1.toString()} wei)`
      )
    );

    // Calculate and display swap results
    console.log(chalk.blue("\n📊 Swap Results:"));
    const token0Change = balancesAfter.token0 - balancesBefore.token0;
    const token1Change = balancesAfter.token1 - balancesBefore.token1;

    if (tokenInIs0) {
      console.log(
        chalk.green(
          `   ${UNISWAP_CFG.token0Symbol} spent: ${ethers.formatUnits(-token0Change, UNISWAP_CFG.token0Decimals)}`
        )
      );
      console.log(
        chalk.green(
          `   ${UNISWAP_CFG.token1Symbol} received: ${ethers.formatUnits(token1Change, UNISWAP_CFG.token1Decimals)}`
        )
      );
      if (validationResult.amountOut > 0n) {
        console.log(
          chalk.gray(
            `   Actual out (from validation): ${ethers.formatUnits(validationResult.amountOut, UNISWAP_CFG.token1Decimals)} ${UNISWAP_CFG.token1Symbol}`
          )
        );
      }
    } else {
      console.log(
        chalk.green(
          `   ${UNISWAP_CFG.token1Symbol} spent: ${ethers.formatUnits(-token1Change, UNISWAP_CFG.token1Decimals)}`
        )
      );
      console.log(
        chalk.green(
          `   ${UNISWAP_CFG.token0Symbol} received: ${ethers.formatUnits(token0Change, UNISWAP_CFG.token0Decimals)}`
        )
      );
      if (validationResult.amountOut > 0n) {
        console.log(
          chalk.gray(
            `   Actual out (from validation): ${ethers.formatUnits(validationResult.amountOut, UNISWAP_CFG.token0Decimals)} ${UNISWAP_CFG.token0Symbol}`
          )
        );
      }
    }

    // Verify the swap was successful
    const swapSuccessful =
      (tokenInIs0 && token0Change < 0n && token1Change > 0n) ||
      (!tokenInIs0 && token1Change < 0n && token0Change > 0n);

    if (swapSuccessful) {
      console.log(chalk.green("\n✅ Swap completed successfully!"));
    } else {
      console.log(
        chalk.yellow(
          "\n⚠️ Swap transaction confirmed, but balance changes look unexpected. Please verify manually."
        )
      );
    }

    console.log(chalk.blue("\n✨ Test completed!"));
  } catch (error: any) {
    spinner.fail("Swap test failed");
    console.error(chalk.red("\n❌ Error:"), error.message);
    if (error.transaction) {
      console.error(chalk.red("Transaction hash:"), error.transaction.hash);
    }
    if (error.receipt) {
      console.error(chalk.red("Transaction receipt:"), error.receipt);
    }
    process.exit(1);
  }
}

// Run the test
testSwap().catch((error) => {
  console.error(chalk.red("Fatal error:"), error);
  process.exit(1);
});

