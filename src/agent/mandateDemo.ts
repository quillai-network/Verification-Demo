// examples/ab-flow.ts
import { Wallet } from "ethers";
import { Mandate, addrFromCaip10, caip10 } from "../core/mandate";

type Intent = { text: string };
import { SwapCore, SwapPayload } from "types/mandate";


import { verifyMandateAsThirdParty } from "./verifier/thirdParty";

function isSwapCore(x: unknown): x is SwapCore {
    const o = x as any;
    return (
      o &&
      o.kind === "swap@1" &&
      o.payload &&
      typeof o.payload.amountIn === "string"
    );
  }

async function main() {
  // Agents (wallets)
  const agentA = Wallet.createRandom();
  const agentB = Wallet.createRandom();

  // Step 1: A -> B (intent)
  const intent: Intent = { text: "Swap 100 USDC for WBTC on Ethereum mainnet." };

  // Step 2: B creates the mandate + core + signs as server
  const mandateFromB = new Mandate({
    version: "0.1.0",
    client: caip10(1, agentA.address), // A is the client
    server: caip10(1, agentB.address), // B is the server
    deadline: new Date(Date.now() + 20 * 60 * 1000).toISOString(),
    intent: intent.text,
    core: {
      kind: "swap@1",
      payload: {
        chainId: 1,
        tokenIn: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
        tokenOut: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
        amountIn: "100000000", // 100 USDC (6 decimals)
        minOut: "165000",      // ~0.00165 WBTC (example)
        recipient: agentA.address,
        deadline: new Date(Date.now() + 15 * 60 * 1000).toISOString()
      }
    }
  });
  await mandateFromB.signAsServer(agentB, "eip191");

  // Step 3: B -> A (send signed mandate)
  const receivedByA = Mandate.fromObject(mandateFromB.toJSON());

  // Step 4: A verifies B's signature and decides to accept or reject
  try {
    // Verify server sig (B)
    receivedByA.verifyRole("server");

   // A performs local checks on terms

//if (!isSwapCore(core)) throw new Error("unexpected core shape for swap@1");
// A performs local checks on terms
const core = receivedByA.toJSON().core;
if (!isSwapCore(core)) throw new Error("unexpected core shape for swap@1");

const ok = core.payload.amountIn === "100000000";
if (!ok) throw new Error("terms not acceptable");

    // A accepts → sign as client
    await receivedByA.signAsClient(agentA, "eip191");

    // Step 5: A -> B (return countersigned mandate)
    const returnedToB = Mandate.fromObject(receivedByA.toJSON());

    // B verifies A’s signature, then proceeds to execute task
    returnedToB.verifyRole("client"); // verify A
    returnedToB.verifyRole("server"); // re-verify self if desired

    

    // ... execute task here ...
    console.log("✅ Accepted. B proceeds to execute task based on mandate.");
    console.log(JSON.stringify(returnedToB.toJSON(), null, 2));


    const countersigned = returnedToB.toJSON();

    // If the mandate used EIP-191, no domain needed.
    // If it used EIP-712, supply the same domain(s) that signers used.
    const result = verifyMandateAsThirdParty(countersigned, {
      // optional assertions:
      requireClient: addrFromCaip10(countersigned.client),
      requireServer: addrFromCaip10(countersigned.server),
      primitive: "swap@1",
      // eip712ClientDomain: { name: "Mandate", version: "1", chainId: 1 },
      // eip712ServerDomain: { name: "Mandate", version: "1", chainId: 1 },
    });
    
    console.log("Third-party verification:", result.ok, result);

  } catch (err) {
    // A rejects
    console.error("❌ Rejected mandate:", (err as Error).message);
    // B will not execute.
  }
}

main().catch(console.error);
