# WachAI ERC-8004 Mandate Validation Demo


This demo showcases how ai agents can **verify**, **sign**, and **provide feedback** to each other on **ERC-8004 validation registry** by using **WachAI’s Verification Network and mandates SDK**. It demonstrates end-to-end agent collaboration, starting from **discovery**, to **communication**, to **verifiable signing and feedback loops**.

### Core Components

- **ChaosChain SDK** → Used for **agent discovery** and registration on ERC-8004.  
- **XMTP** → Enables **secure, decentralized agent-to-agent messaging**.  
- **WachAI SDK** → Powers **signing, verification, and feedback exchange** for job mandates registered under **ERC-8004**.

Together, these tools form a verifiable and trust-minimized framework for how AI agents coordinate and hold each other accountable within decentralized ecosystems.

---

## Setup Instructions

### 1. Install Dependencies
```bash
npm i
```

### 2. Initialize Environment
```bash
npm run setup
```

This command generates fresh wallet keys for:

- Server 

- Client

- Validator

- Swap wallet

and creates a new .env file with these credentials.


### 3. Setup IPFS via Pinata

You’ll need a Pinata Cloud account to store metadata on IPFS.

Add your JWT key to the .env file:

```bash
PINATA_JWT=your_pinata_jwt_token
```

### 4. Fund Wallets

Each generated wallet (SERVER, CLIENT, VALIDATOR, SWAP) must be funded with:

ETH → for gas fees
🔗 Get ETH from Sepolia Faucet

Test USDC → for ERC-20 interactions
🔗 Get Test USDC from Circle Faucet

Ensure all four wallets have sufficient ETH and test USDC before proceeding.


## Running the Demo

Once setup is complete and wallets are funded, run the demo agents in sequence:

```bash
# Start Server Agent (Provider) first
npm run server-agent

# In another terminal, start Client Agent (Requester)
npm run client-agent

# Optionally, start Validator Agent in another terminal (demo starts it automatically)
npm run agent-validator
```

## Project Structure

```
├── src/
│   ├── agent/
│   │   ├── clientAgent.ts       # Swap requester agent (Client Agent)
│   │   ├── serverAgent.ts       # Swap provider agent (Server Agent)
│   │   ├── validatorAgent.ts    # On-chain validation responder
│   │   └── verifier/
│   │       └── thirdParty.ts    # Third-party mandate verification
│   ├── services/
│   │   ├── uniswap/
│   │   │   ├── uniswapV3.ts     # Uniswap V3 swap execution & validation
│   │   │   ├── uniswap.config.ts # Uniswap configuration
│   │   │   └── abis.ts          # Contract ABIs
│   │   └── customPinataService.ts # IPFS storage via Pinata
│   ├── core/
│   │   ├── mandate.ts           # Mandate creation and verification
│   │   └── mandate-base.ts     # Base mandate implementation
│   └── types/                   # TypeScript type definitions
├── scripts/
│   ├── testSwap.ts              # Test script for swap functionality
│   ├── setup.js                 # Setup script for environment
│   └── revokeInstalaltions.ts   # Revoke XMTP installations helper
├── db/                          # Local XMTP databases (gitignored)
├── demo.ts                      # Demo orchestration script (TypeScript)
├── package.json                 # Dependencies and scripts
├── tsconfig.json                # TypeScript configuration
└── README.md                    # This file
```

## Swap Execution Modes

The Server Agent supports two execution modes:

### Dry Run Mode (Default)
- Set `UNISWAP_DRY_RUN=true` in your `.env` file
- No actual blockchain transactions are executed
- Mock transaction hashes are generated
- Safe for testing and development
- No gas fees or token balances required

### Live Mode
- Set `UNISWAP_DRY_RUN=false` or omit the variable
- Executes actual swaps on-chain via Uniswap V3
- Validates transactions after execution
- Stores validation proofs on IPFS
- Requires:
  - Sufficient token balances for swaps
  - ETH for gas fees
  - Valid Uniswap V3 contract addresses

**Swapping:**
After each swap execution (in live mode), the agent automatically:
1. Executes the swap transaction on Uniswap V3
2. Waits for transaction confirmation
3. Validates the swap by decoding transaction logs
4. Verifies swap amounts and direction
5. Includes validation results in proof data stored on IPFS


## Revoke XMTP Installations

If you need to revoke old XMTP installations (for example, to force a fresh session), use the provided script:

```bash
# Usage
npm run revoke-installations -- <inbox-id> [installations-to-save]

# Example: keep current installation only
npm run revoke-installations -- 743f3805fa9daaf879103bc26a2e79bb53db688088259c23cf18dcf1ea2aee64

# Example: keep a comma-separated list of installation IDs
npm run revoke-installations -- 743f38...ee64 "current-installation-id,another-installation-id"
```

Requirements (in your .env):
- `CLIENT_AGENT_PRIVATE_KEY`
- `SERVER_AGENT_PRIVATE_KEY`
- `XMTP_DB_ENCRYPTION_KEY`
- `XMTP_ENV` (e.g., `dev`)

## Stop All Agents Quickly

If something goes wrong, stop all running agents with:

```bash
pkill -f "tsx.*src/agent/(serverAgent|clientAgent|validatorAgent)\.ts"
```

This sends SIGTERM to matching processes; the demo and agents handle SIGTERM for clean shutdown.

