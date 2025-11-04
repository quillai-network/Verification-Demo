import { spawn, ChildProcess } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';

console.log(chalk.bold.cyan('\n🚀 Agent Mandates Demo - USDC to ETH Swap\n'));
console.log(chalk.gray('This demo shows two agents communicating through XMTP to execute a swap:\n'));
console.log(chalk.gray('1. Client Agent requests a 1 USDC → ETH swap'));
console.log(chalk.gray('2. Server Agent provides a Uniswap quote'));
console.log(chalk.gray('3. Client Agent accepts the quote'));
console.log(chalk.gray('4. Server Agent executes the swap and provides proof'));
console.log(chalk.gray('5. Client Agent submits feedback for Server Agent\n'));

const spinner = ora('Starting Agents...').start();
console.log('')
// Start Server Agent first (the provider)
console.log(chalk.yellow('\n🤖 Starting Server Agent (Swap Provider)...'));
const serverAgent: ChildProcess = spawn('npx', ['tsx', 'src/agent/serverAgent.ts'], {
  stdio: 'inherit',
  env: { ...process.env }
});

// Wait a moment for Server Agent to initialize
await new Promise<void>(resolve => setTimeout(resolve, 3000));

// Start Validator Agent
console.log(chalk.yellow('\n🛡️ Starting Validator Agent...'));
const validatorAgent: ChildProcess = spawn('npx', ['tsx', 'src/agent/validatorAgent.ts'], {
  stdio: 'inherit',
  env: { ...process.env }
});

// Give validator a moment as well
await new Promise<void>(resolve => setTimeout(resolve, 2000));

// Start Client Agent (the requester)
console.log(chalk.yellow('\n🤖 Starting Client Agent (Swap Requester)...'));
const clientAgent: ChildProcess = spawn('npx', ['tsx', 'src/agent/clientAgent.ts'], {
  stdio: 'inherit',
  env: { ...process.env }
});

spinner.succeed('Agent Runtime started successfully!');

console.log(chalk.cyan('\n📊 Demo Status:'));
console.log(chalk.green('✅ Server Agent (Provider) - Running'));
console.log(chalk.green('✅ Validator Agent - Running'));
console.log(chalk.green('✅ Client Agent (Requester) - Running'));
console.log(chalk.gray('\nWatch the console for the swap flow demonstration...'));
console.log(chalk.gray('Press Ctrl+C to stop both agents\n'));

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log(chalk.yellow('\n🛑 Shutting down demo...'));
  
  clientAgent.kill('SIGINT');
  serverAgent.kill('SIGINT');
  validatorAgent.kill('SIGINT');
  
  setTimeout(() => {
    console.log(chalk.green('✅ Demo stopped successfully!'));
    process.exit(0);
  }, 2000);
});

// Handle SIGTERM (e.g., pkill default)
process.on('SIGTERM', () => {
  console.log(chalk.yellow('\n🛑 Shutting down demo (SIGTERM)...'));
  
  clientAgent.kill('SIGTERM');
  serverAgent.kill('SIGTERM');
  validatorAgent.kill('SIGTERM');
  
  setTimeout(() => {
    console.log(chalk.green('✅ Demo stopped successfully!'));
    process.exit(0);
  }, 2000);
});

// Handle process errors
clientAgent.on('error', (error: Error) => {
  console.error(chalk.red(`❌ Client Agent error: ${error.message}`));
  process.exit(1);
});

serverAgent.on('error', (error: Error) => {
  console.error(chalk.red(`❌ Server Agent error: ${error.message}`));
  process.exit(1);
});

validatorAgent.on('error', (error: Error) => {
  console.error(chalk.red(`❌ Validator Agent error: ${error.message}`));
  process.exit(1);
});

clientAgent.on('exit', (code: number | null) => {
  if (code !== 0) {
    console.log(chalk.yellow(`⚠️  Client Agent exited with code ${code}`));
  }
});

serverAgent.on('exit', (code: number | null) => {
  if (code !== 0) {
    console.log(chalk.yellow(`⚠️  Server Agent exited with code ${code}`));
  }
});

validatorAgent.on('exit', (code: number | null) => {
  if (code !== 0) {
    console.log(chalk.yellow(`⚠️  Validator Agent exited with code ${code}`));
  }
  console.log(chalk.yellow('📥 Validator Agent exited, stopping remaining agents...'));
  try { serverAgent.kill('SIGTERM'); } catch {}
  try { clientAgent.kill('SIGTERM'); } catch {}
  process.exit(1);
});
