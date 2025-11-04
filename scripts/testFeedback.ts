import dotenv from 'dotenv';
import { ethers } from 'ethers';
import chalk from 'chalk';

dotenv.config();

// Reputation Contract ABI (minimal)
const REPUTATION_ABI = [
    "function giveFeedback(uint256 agentId, uint8 score, bytes32 tag1, bytes32 tag2, string feedbackUri, bytes32 feedbackHash, bytes auth) external",
    "function isAgentRegistered(uint256 agentId) view returns (bool)",
    "function getAgent(uint256 agentId) view returns (address agentAddress)"
];

// Identity Registry ABI to check agent registrations
const IDENTITY_ABI = [
    "function getAgentId(address agentAddress) view returns (uint256)",
    "function ownerOf(uint256 agentId) view returns (address)",
    "function isApprovedForAll(address owner, address operator) view returns (bool)"
];

const REPUTATION_CONTRACT = "0x8004B8FD1A363aa02fDC07635C0c5F94f6Af5B7E";
const IDENTITY_REGISTRY = "0x8004a6090Cd10A7288092483047B097295Fb8847";

async function debugFeedback(executeTransaction: boolean = false) {
    const rpcUrl = process.env.ETHEREUM_SEPOLIA_RPC_URL || "https://rpc.sepolia.org";
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    // Get private key for transaction execution
    let wallet: ethers.Wallet | null = null;
    if (executeTransaction) {
        const privateKey = process.env.CLIENT_AGENT_PRIVATE_KEY;
        if (!privateKey) {
            throw new Error("CLIENT_AGENT_PRIVATE_KEY not found in environment");
        }
        wallet = new ethers.Wallet(privateKey, provider);
        const balance = await provider.getBalance(wallet.address);
        console.log(chalk.blue(`\n💰 Wallet: ${wallet.address}`));
        console.log(chalk.blue(`   Balance: ${ethers.formatEther(balance)} ETH`));
        if (balance === 0n) {
            throw new Error("Wallet has zero ETH balance");
        }
    }

    const contract = wallet
        ? new ethers.Contract(REPUTATION_CONTRACT, REPUTATION_ABI, wallet)
        : new ethers.Contract(REPUTATION_CONTRACT, REPUTATION_ABI, provider);

    const identityContract = new ethers.Contract(IDENTITY_REGISTRY, IDENTITY_ABI, provider);

    // Check what agent ID the caller is registered with (if any)
    let callerAgentId: bigint | null = null;
    if (wallet) {
        try {
            let agentIdResult = 0n;
            const agentOwner = await identityContract.ownerOf(760n);
            console.log(agentOwner, wallet.address)
            if(agentOwner.toLowerCase() === wallet.address.toLowerCase()) {
                agentIdResult = 760n;
            }
            if (agentIdResult && agentIdResult > 0n) {
                callerAgentId = BigInt(agentIdResult.toString());
                console.log(chalk.cyan(`\n📋 Caller Information:`));
                console.log(chalk.cyan(`   Caller Address: ${wallet.address}`));
                console.log(chalk.cyan(`   Caller Agent ID: ${callerAgentId.toString()}`));
            } else {
                console.log(chalk.yellow(`\n⚠ Caller is not registered with an agent ID`));
            }
        } catch (e: any) {
            console.log(chalk.yellow(`\n⚠ Could not get caller's agent ID: ${e.message}`));
            console.log(chalk.yellow(`   This might mean the caller is not registered yet`));
        }
    }

    // Your test values - update these with actual values
    const agentId = 759n;
    
    // Check if caller is trying to give feedback to themselves
    if (callerAgentId !== null && callerAgentId === agentId) {
        console.log(chalk.red(`\n❌ SELF-FEEDBACK DETECTED!`));
        console.log(chalk.red(`   Caller Agent ID: ${callerAgentId}`));
        console.log(chalk.red(`   Target Agent ID: ${agentId}`));
        console.log(chalk.red(`   These are the same! The contract will reject this.`));
        console.log(chalk.yellow(`\n💡 Solution:`));
        console.log(chalk.yellow(`   - Make sure CLIENT_AGENT_PRIVATE_KEY is different from SERVER_AGENT_PRIVATE_KEY`));
        console.log(chalk.yellow(`   - Ensure the Client Agent has registered with a different agent ID than the Server Agent`));
        console.log(chalk.yellow(`   - Verify the targetAgentId in your feedback is the Server Agent's ID, not the Client Agent's ID`));
        return;
    }
    const score = 100;
    const tag1 = ethers.ZeroHash;
    const tag2 = ethers.ZeroHash;
    const feedbackUri = "ipfs://QmTwsWbjk8wfebvPpvqq4aYzbEF8cuETQbRqxgvViwAtoK"; // Your actual URI
    const feedbackContent = "Swap execution 1234567890 completed. TX: 0x1234567890";
    const feedbackHash = ethers.keccak256(ethers.toUtf8Bytes(feedbackContent));
    const feedbackAuth = "0x00000000000000000000000000000000000000000000000000000000000002f40000000000000000000000009c5dd0e56e5801448cc015b31c521fdd965aeb6b00000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000069051da30000000000000000000000000000000000000000000000000000000000aa36a70000000000000000000000008004a6090cd10a7288092483047b097295fb8847000000000000000000000000ee0404387ba40f132db271bf5b0056ffb502ae627c59cc227a378c75137da1d6e208716e0137d6f937c215a83e82cf430c66a48f68ef16992b88306f3b010dc0ffefc9263c6a365baebe5005cc23e832d67940fd1c"; // Your actual auth or "0x" if empty

    console.log(chalk.blue("🔍 Debugging Feedback Transaction\n"));
    console.log(chalk.gray(`📋 Parameters:`));
    console.log(chalk.gray(`   Agent ID: ${agentId}`));
    console.log(chalk.gray(`   Score: ${score}`));
    console.log(chalk.gray(`   Feedback URI: ${feedbackUri}`));
    console.log(chalk.gray(`   Feedback Hash: ${feedbackHash}`));
    console.log(chalk.gray(`   Feedback Auth: ${feedbackAuth.slice(0, 20) + "..."}`));
    console.log("");

    // 1. Check if agent is registered
    try {
        const isRegistered = await contract.isAgentRegistered(agentId);
        console.log(chalk.cyan(`✓ Agent ${agentId} registered: ${isRegistered}`));

        if (!isRegistered) {
            console.log(chalk.red(`\n❌ Agent ${agentId} is not registered!`));
            return;
        }
    } catch (e: any) {
        console.log(chalk.yellow(`⚠ Could not check registration: ${e.message}`));
    }

    // 2. Try to get agent address and owner
    try {
        const agentAddress = await contract.getAgent(agentId);
        console.log(chalk.cyan(`✓ Agent ${agentId} address: ${agentAddress}`));
        
        // Get owner from identity registry
        const owner = await identityContract.ownerOf(agentId);
        console.log(chalk.cyan(`✓ Agent ${agentId} owner: ${owner}`));
        
        // Check if caller is the owner
        if (wallet && wallet.address.toLowerCase() === owner.toLowerCase()) {
            console.log(chalk.yellow(`\n⚠️  WARNING: Caller is the owner of target agent!`));
            console.log(chalk.yellow(`   This might cause self-feedback detection if the contract checks ownership.`));
        }
        
        // Check what agent ID the owner has
        try {
            const ownerAgentId = await identityContract.getAgentId(owner);
            console.log(chalk.cyan(`✓ Owner's Agent ID: ${ownerAgentId.toString()}`));
            
            if (wallet && callerAgentId !== null && ownerAgentId === callerAgentId) {
                console.log(chalk.red(`\n❌ SELF-FEEDBACK DETECTED via ownership!`));
                console.log(chalk.red(`   Caller owns both their own agent (${callerAgentId}) and target agent (${agentId})`));
                console.log(chalk.red(`   The contract checks if the caller is the owner of the target agent`));
                return;
            }
        } catch (e) {
            // Owner might not be registered
        }
    } catch (e: any) {
        console.log(chalk.yellow(`⚠ Could not get agent address: ${e.message}`));
    }

    // 3. Simulate the transaction
    console.log(chalk.blue("\n📋 Simulating transaction..."));
    try {
        // In ethers v6, use staticCall method
        const result = await contract.giveFeedback.staticCall(
            agentId,
            score,
            tag1,
            tag2,
            feedbackUri,
            feedbackHash,
            feedbackAuth
        );
        console.log(chalk.green("✓ Simulation successful! Transaction would succeed."));

        // If executeTransaction is true, proceed with actual transaction
        if (executeTransaction && wallet) {
            console.log(chalk.blue("\n📤 Executing actual transaction..."));
            const tx = await contract.giveFeedback(
                agentId,
                score,
                tag1,
                tag2,
                feedbackUri,
                feedbackHash,
                feedbackAuth,
                {
                    gasLimit: 200000n
                }
            );
            console.log(chalk.cyan(`   Transaction Hash: ${tx.hash}`));
            console.log(chalk.blue("   Waiting for confirmation..."));
            const receipt = await tx.wait();

            if (receipt && receipt.status === 1) {
                console.log(chalk.green("\n✅ Transaction confirmed!"));
                console.log(chalk.gray(`   Block: ${receipt.blockNumber}`));
                console.log(chalk.gray(`   Gas Used: ${receipt.gasUsed.toString()}`));
            } else {
                console.log(chalk.red("\n❌ Transaction failed!"));
            }
        }
    } catch (error: any) {
        console.log(chalk.red("\n❌ Simulation failed!"));
        console.log(chalk.red(`   Error: ${error.message}`));

        // Try to decode error data
        if (error.data) {
            console.log(chalk.yellow(`\n📊 Error Details:`));
            console.log(chalk.yellow(`   Error Data: ${error.data}`));

            // Common error selectors (from contract)
            const errorSelectors: Record<string, string> = {
                "0x82b42900": "UnauthorizedFeedback()",
                "0x4e543b26": "AgentNotRegistered()",
                "0x8f0b3f89": "InvalidRating()",
                "0x8456cb59": "Paused()",
                // Add more based on your contract's custom errors
            };

            const selector = error.data.slice(0, 10);
            if (errorSelectors[selector]) {
                console.log(chalk.red(`   Error Type: ${errorSelectors[selector]}`));
            }
        }

        // Check revert reason
        if (error.reason) {
            console.log(chalk.red(`   Revert Reason: ${error.reason}`));
        }

        // Check for specific error messages
        const errorMsg = error.message || "";
        if (errorMsg.includes("UnauthorizedFeedback") || errorMsg.includes("unauthorized")) {
            console.log(chalk.yellow(`\n💡 Issue: Feedback authorization is invalid or expired`));
            console.log(chalk.yellow(`   - Check if feedbackAuth is correctly formatted`));
            console.log(chalk.yellow(`   - Verify the authorization was generated by the target agent`));
            console.log(chalk.yellow(`   - Check if the authorization has expired`));
        }

        if (errorMsg.includes("AgentNotRegistered") || errorMsg.includes("not registered")) {
            console.log(chalk.yellow(`\n💡 Issue: Agent ID ${agentId} is not registered on-chain`));
            console.log(chalk.yellow(`   - Verify the agent ID is correct`));
            console.log(chalk.yellow(`   - Check if the agent has called registerIdentity()`));
        }

        if (errorMsg.includes("InvalidRating") || errorMsg.includes("rating")) {
            console.log(chalk.yellow(`\n💡 Issue: Rating ${score} is invalid`));
            console.log(chalk.yellow(`   - Rating must be between 0 and 100`));
        }
        
        if (errorMsg.includes("Self-feedback") || errorMsg.includes("self")) {
            console.log(chalk.yellow(`\n💡 Issue: Self-feedback not allowed`));
            console.log(chalk.yellow(`   - The contract detected you're trying to give feedback to yourself`));
            console.log(chalk.yellow(`   - Caller Agent ID: ${callerAgentId !== null ? callerAgentId.toString() : 'unknown'}`));
            console.log(chalk.yellow(`   - Target Agent ID: ${agentId}`));
            console.log(chalk.yellow(`\n   Possible causes:`));
            console.log(chalk.yellow(`   1. Caller and target have the same agent ID`));
            console.log(chalk.yellow(`   2. Caller is the owner of the target agent`));
            console.log(chalk.yellow(`   3. Contract checks msg.sender's agent ID matches target`));
            console.log(chalk.yellow(`\n   Solutions:`));
            console.log(chalk.yellow(`   - Ensure CLIENT_AGENT_PRIVATE_KEY ≠ SERVER_AGENT_PRIVATE_KEY`));
            console.log(chalk.yellow(`   - Register Client and Server agents separately with different IDs`));
            console.log(chalk.yellow(`   - Use the correct Server Agent ID (not Client Agent ID) as target`));
        }
    }
}

// Check command line arguments
const executeTransaction = process.argv.includes('--execute') || process.argv.includes('-e');

if (import.meta.url === `file://${process.argv[1]}`) {
    debugFeedback(executeTransaction).catch(console.error);
}

export { debugFeedback };