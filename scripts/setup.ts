import { readFileSync, writeFileSync, existsSync } from 'fs';
import { ethers } from 'ethers';
import chalk from 'chalk';
import ora from 'ora';

console.log(chalk.bold.cyan('\n🔧 Agent Mandates Demo Setup\n'));

async function generateWallet() {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey
  };
}

async function setupEnvironment() {
  const spinner = ora('Setting up environment...').start();
  console.log('')
  try {
    // Check if .env already exists
    if (existsSync('.env')) {
      spinner.warn('.env file already exists. Skipping generation.');
      return;
    }

    // Generate wallets for agents (Client, Server, and Validator)
    console.log(chalk.yellow('\n🔑 Generating wallets for agents...'));

    const clientAgent = await generateWallet();
    const serverAgent = await generateWallet();
    const validator = await generateWallet();
    const uniswapPrivateKey = await generateWallet();

    console.log(chalk.green('✅ Client Agent wallet generated:'));
    console.log(chalk.gray(`   Address: ${clientAgent.address}`));
    console.log(chalk.gray(`   Private Key: ${clientAgent.privateKey}`));

    console.log(chalk.green('✅ Server Agent wallet generated:'));
    console.log(chalk.gray(`   Address: ${serverAgent.address}`));
    console.log(chalk.gray(`   Private Key: ${serverAgent.privateKey}`));

    console.log(chalk.green('✅ Validator wallet generated:'));
    console.log(chalk.gray(`   Address: ${validator.address}`));
    console.log(chalk.gray(`   Private Key: ${validator.privateKey}`));

    // Read template
    const template = readFileSync('.env.example', 'utf8');

    // Generate XMTP DB encryption key (32 bytes hex)
    const dbEncryptionKey = ethers.hexlify(ethers.randomBytes(32));

    // Replace placeholders
    const envContent = template
      // Client Agent private key placeholder
      .replace('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', clientAgent.privateKey)
      // Client Agent address placeholder
      .replace('0x123456789012345678901234567890123456897', clientAgent.address)
      // Server Agent private key placeholder
      .replace('0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890', serverAgent.privateKey)
      // Server Agent address placeholder
      .replace('0x123456789012345678901234567890124569871', serverAgent.address)
      // Validator private key placeholder
      .replace('0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed', validator.privateKey)
      // Validator address placeholder
      .replace('0x1234567890123456789012345678901234567890', validator.address)
      // XMTP DB encryption key placeholder
      .replace('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', dbEncryptionKey)
      // UNISWAP PRIVATE KEy
      .replace('0x1234567890abcdef1234567890abcdef545742375341324364', uniswapPrivateKey.privateKey)
      // SWAP WALLET
      .replace('0x8756434657561324378312313461Af5524', uniswapPrivateKey.address);

    // Write .env file
    writeFileSync('.env', envContent);

    spinner.succeed('Environment setup complete!');

    console.log(chalk.yellow('\n⚠️  Important:'));
    console.log(chalk.gray('1. Fund all the agent wallets with Sepolia ETH for gas fees'));
    console.log(chalk.gray('2. Update ETHEREUM_SEPOLIA_RPC_URL with your Infura/Alchemy URL'));
    console.log(chalk.gray('3. Never share your private keys or commit them to version control'));

    console.log(chalk.cyan('\n📋 Next Steps:'));
    console.log(chalk.gray('1. Get Sepolia ETH from a faucet and fund all the agent wallets: '));
    console.log(chalk.blue('   https://sepoliafaucet.com/'));
    console.log(chalk.gray('2. Update your .env file with a valid RPC URL and Pinata Keys'));
    console.log(chalk.gray('2. Fund the swap wallet with USDC and ETH for swaps: [optional- Only when UNISWAP_DRY_RUN=false]'));
    console.log(chalk.blue('   https://faucet.circle.com/'))
    console.log(chalk.gray('3. Run: npm run demo'));

  } catch (error: any) {
    spinner.fail('Setup failed');
    console.error(chalk.red(`❌ Error: ${error.message}`));
    process.exit(1);
  }
}

async function checkDependencies() {
  const spinner = ora('Checking dependencies...').start();
  console.log('')

  try {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
    const requiredDeps = [
      '@xmtp/agent-sdk',
      '@chaoschain/sdk',
      '@uniswap/v3-sdk',
      'ethers',
      'dotenv',
      'chalk',
      'ora'
    ];

    const missingDeps = requiredDeps.filter(dep => !packageJson.dependencies[dep]);

    if (missingDeps.length > 0) {
      spinner.fail('Missing dependencies');
      console.log(chalk.red(`❌ Missing dependencies: ${missingDeps.join(', ')}`));
      console.log(chalk.yellow('Run: npm install'));
      process.exit(1);
    }

    spinner.succeed('All dependencies installed');

  } catch (error: any) {
    spinner.fail('Dependency check failed');
    console.error(chalk.red(`❌ Error: ${error.message}`));
    process.exit(1);
  }
}

async function main() {
  try {
    await checkDependencies();
    await setupEnvironment();

    console.log(chalk.bold.green('\n🎉 Setup complete! You\'re ready to run the demo.'));

  } catch (error: any) {
    console.error(chalk.red(`❌ Setup failed: ${error.message}`));
    process.exit(1);
  }
}

main();
