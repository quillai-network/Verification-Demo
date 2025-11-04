import { ethers } from "ethers";
import { ERC20_ABI, NFPM_ABI, SWAP_ROUTER02_ABI, V3_FACTORY_ABI, V3_QUOTER_ABI, V3_POOL_ABI } from "./abis";
import { UNISWAP_CFG } from "./uniswap.config";

function safeJsonStringify(value: unknown): string {
    try {
        return JSON.stringify(value, (_key, val) =>
            typeof val === "bigint" ? val.toString() : val,
        );
    } catch {
        return String(value);
    }
}

const BPS_DENOMINATOR = 10_000n;
const DEFICIT_SWAP_BUFFER_BPS = 100n; // +1% buffer on amountIn estimates
const DEFICIT_MIN_OUT_BPS = 9_900n; // allow up to 1% negative slippage on outputs

function applyBpsIncrease(amount: bigint, bufferBps: bigint): bigint {
    if (amount === 0n) return 0n;
    return amount + (amount * bufferBps + (BPS_DENOMINATOR - 1n)) / BPS_DENOMINATOR;
}

function applyBpsFloor(amount: bigint, floorBps: bigint): bigint {
    if (amount === 0n) return 0n;
    const floored = (amount * floorBps) / BPS_DENOMINATOR;
    return floored > 0n ? floored : 1n;
}


export interface MintParams {
    tickLower: number;
    tickUpper: number;
    amount0Desired: ethers.BigNumberish;
    amount1Desired: ethers.BigNumberish;
    amount0Min: ethers.BigNumberish;
    amount1Min: ethers.BigNumberish;
    recipient: string;
    deadline: number;
}

export interface IncreaseParams {
    tokenId: ethers.BigNumberish;
    amount0Desired: ethers.BigNumberish;
    amount1Desired: ethers.BigNumberish;
    amount0Min: ethers.BigNumberish;
    amount1Min: ethers.BigNumberish;
    deadline: number;
}

export interface SwapValidationResult {
    isValid: boolean;
    transactionHash: string;
    blockNumber: number;
    tokenInIs0: boolean;
    amountIn: bigint;
    amountOut: bigint;
    tokenInAddress: string;
    tokenOutAddress: string;
    poolAddress: string;
    recipient: string;
    errors?: string[];
    warnings?: string[];
}

export class UniswapV3Manager {
    private provider: ethers.JsonRpcProvider;
    private wallet: ethers.Wallet;
    private token0: ethers.Contract;
    private token1: ethers.Contract;
    private router: ethers.Contract;
    private factory: ethers.Contract;
    private quoter?: ethers.Contract;
    // v3 smart order router is loaded dynamically inside swapV3RoutedExactIn

    private coerceToBigInt(value: unknown, context?: string): bigint {
        try {
            return ethers.toBigInt(value as any);
        } catch {
            // fall through to manual handling
        }
        if (typeof value === "bigint") return value;
        if (typeof value === "number") return BigInt(Math.trunc(value));
        if (typeof value === "string") {
            const trimmed = value.trim();
            if (trimmed.length === 0) throw new Error(`Cannot convert empty string to BigInt${context ? ` (${context})` : ""}`);
            return BigInt(trimmed);
        }
        if (value && typeof value === "object") {
            if ("toBigInt" in value && typeof (value as any).toBigInt === "function") {
                return (value as any).toBigInt();
            }
            if ("toString" in value && typeof (value as any).toString === "function") {
                const str = (value as any).toString();
                if (typeof str === "string" && str.trim().length > 0) {
                    return BigInt(str.trim());
                }
            }
            const json = safeJsonStringify(value);
            throw new SyntaxError(`Cannot convert object to BigInt${context ? ` (${context})` : ""}: ${json}`);
        }
        throw new SyntaxError(`Cannot convert ${String(value)} to BigInt${context ? ` (${context})` : ""}`);
    }

    constructor(privateKey: string) {
        if (!UNISWAP_CFG.rpcUrl) throw new Error("RPC_URL missing");
        if (!process.env.UNISWAP_V3_SWAP_ROUTER) throw new Error("UNISWAP_V3_SWAP_ROUTER missing");
        if (!UNISWAP_CFG.token0 || !UNISWAP_CFG.token1) throw new Error("Token addresses missing");
        
        this.provider = new ethers.JsonRpcProvider(UNISWAP_CFG.rpcUrl, UNISWAP_CFG.chainId);
        this.wallet = new ethers.Wallet(privateKey, this.provider);
        
        this.token0 = new ethers.Contract(UNISWAP_CFG.token0, ERC20_ABI, this.wallet);
        this.token1 = new ethers.Contract(UNISWAP_CFG.token1, ERC20_ABI, this.wallet);
        const routerAddr = process.env.UNISWAP_V3_SWAP_ROUTER
        this.router = new ethers.Contract(routerAddr, SWAP_ROUTER02_ABI, this.wallet);
        this.factory = new ethers.Contract(UNISWAP_CFG.factory, V3_FACTORY_ABI, this.wallet);
        if (UNISWAP_CFG.quoter) {
            // Quoter V2 mutates state (always reverts) unless invoked via static call.
            // Keep it connected with a signer so static calls inherit the wallet address,
            // but ensure we only ever invoke using staticCall to avoid sending transactions.
            this.quoter = new ethers.Contract(UNISWAP_CFG.quoter, V3_QUOTER_ABI, this.wallet);
        }
    }


    async getBalances(owner?: string): Promise<{ token0: bigint; token1: bigint }> {
        const addr = owner ?? (await this.wallet.getAddress());
        const [b0, b1] = await Promise.all([
            this.token0.balanceOf(addr) as Promise<bigint>,
            this.token1.balanceOf(addr) as Promise<bigint>,
        ]);
        return { token0: b0, token1: b1 };
    }

    async ensureRouterApproval(amountIn: bigint, tokenIn: "token0" | "token1"): Promise<void> {
        console.log("💱 Ensuring router approval for", tokenIn, "amountIn:", amountIn.toString());
        const owner = await this.wallet.getAddress();
        const token = tokenIn === "token0" ? this.token0 : this.token1;
        const allowance: bigint = await token.allowance(owner, this.router.target as string);
        if (allowance < amountIn) {
            await (await token.approve(this.router.target as string, amountIn)).wait();
        }
    }

    private async quoteExactOutput(tokenInIs0: boolean, amountOut: bigint): Promise<bigint> {
        if (!this.quoter) {
            throw new Error("UNISWAP_V3_QUOTER not configured; cannot estimate exact-output swap");
        }
        if (amountOut === 0n) return 0n;
        const tokenInAddr = tokenInIs0 ? UNISWAP_CFG.token0 : UNISWAP_CFG.token1;
        const tokenOutAddr = tokenInIs0 ? UNISWAP_CFG.token1 : UNISWAP_CFG.token0;
        const quoteExactOutputSingle = this.quoter.getFunction("quoteExactOutputSingle");
        const quotedRaw = await quoteExactOutputSingle.staticCall({
            tokenIn: tokenInAddr,
            tokenOut: tokenOutAddr,
            amount: amountOut,
            fee: UNISWAP_CFG.fee,
            sqrtPriceLimitX96: 0,
        });
        const rawAmountIn = (quotedRaw as any)?.amountIn ?? (Array.isArray(quotedRaw) ? quotedRaw[0] : (quotedRaw as any)?.[0] ?? quotedRaw);
        if (rawAmountIn === undefined) {
            throw new Error("Quoter returned no amountIn for deficit swap");
        }
        const result = this.coerceToBigInt(rawAmountIn, "quoter.quoteExactOutputSingle amountIn");
        if (result <= 0n) {
            throw new Error("Quoter returned non-positive amountIn for deficit swap");
        }
        return result;
    }

    async swapExactInputSingle(tokenInIs0: boolean, amountIn: bigint, amountOutMinimum: bigint = 0n): Promise<string> {
        // Validate router has code
        console.log("💱 Initiating swap exact input single");
        const code = await this.provider.getCode(this.router.target as string);
        if (code === "0x") throw new Error("Swap router address has no code on this chain");
        // Validate pool exists
        const tokenInAddr = tokenInIs0 ? UNISWAP_CFG.token0 : UNISWAP_CFG.token1;
        const tokenOutAddr = tokenInIs0 ? UNISWAP_CFG.token1 : UNISWAP_CFG.token0;
        const pool = await this.factory.getPool(tokenInAddr, tokenOutAddr, UNISWAP_CFG.fee);
        if (!pool || pool === ethers.ZeroAddress) throw new Error("No V3 pool for token pair/fee");
        // Optional: get quote for min out (set to 0 if no quoter configured)
        let minOut = amountOutMinimum;
        if (this.quoter) {
            try {
                const quoteExactInputSingle = this.quoter.getFunction("quoteExactInputSingle");
                const quotedRaw = await quoteExactInputSingle.staticCall({
                    tokenIn: tokenInAddr,
                    tokenOut: tokenOutAddr,
                    amountIn,
                    fee: UNISWAP_CFG.fee,
                    sqrtPriceLimitX96: 0,
                });
                const rawAmountOut = (quotedRaw as any)?.amountOut ?? (Array.isArray(quotedRaw) ? quotedRaw[0] : (quotedRaw as any)?.[0] ?? quotedRaw);
                if (rawAmountOut === undefined) {
                    throw new Error("Quoter returned no amountOut for deficit swap");
                }
                const amountOutBigInt = this.coerceToBigInt(rawAmountOut, "quoter.quoteExactInputSingle amountOut");
                const buffered = (amountOutBigInt * 99n) / 100n;
                if (minOut === 0n) {
                    minOut = buffered;
                } else if (buffered < minOut) {
                    console.warn(
                        "⚠️ Quoted output below requested minimum; proceeding with caller minimum",
                        { buffered: buffered.toString(), minOut: minOut.toString() },
                    );
                }
            } catch (error) {
                console.log("❌ Error getting quote exact input single");
                console.log(error);
                throw error;
            }
        }
        const params = {
            tokenIn: tokenInAddr,
            tokenOut: tokenOutAddr,
            fee: UNISWAP_CFG.fee,
            recipient: await this.wallet.getAddress(),
            amountIn,
            amountOutMinimum: minOut,
            sqrtPriceLimitX96: 0,
        };
        console.log("💱 Swapping Params:", params);
        await this.ensureRouterApproval(amountIn, tokenInIs0 ? "token0" : "token1");
        
        // Call exactInputSingle directly (deadline protection available via multicall if needed)
        const tx = await this.router.exactInputSingle(params, { value: 0 });
        const receipt = await tx.wait();
        console.log("🧾 Swap tx receipt:", receipt.hash);
        
        // Return transaction hash for validation
        return receipt.hash;
    }

    /**
     * Swaps tokens to get a specific amount of token0 (used for liquidity provision)
     * @param amount0Desired - Desired amount of token0 to receive
     * @param amount1Desired - Desired amount of token1 (unused in current implementation)
     */
    async swapTokens(amount0Desired: bigint, amount1Desired: bigint): Promise<void> {
        try {
            const estimatedIn = await this.quoteExactOutput(false, amount0Desired);
            const swapIn0 = applyBpsIncrease(estimatedIn, DEFICIT_SWAP_BUFFER_BPS);
            const minOut0 = applyBpsFloor(amount0Desired, DEFICIT_MIN_OUT_BPS);
            console.log("💱 Swapping tokens", {
                amount0Desired: amount0Desired.toString(),
                amount1Desired: amount1Desired.toString(),
                estimatedIn: estimatedIn.toString(),
                swapIn0: swapIn0.toString(),
                minOut0: minOut0.toString(),
            });
            await this.ensureRouterApproval(swapIn0, "token1");
            await this.swapExactInputSingle(false, swapIn0, minOut0);
        } catch (error) {
            console.error("❌ Error swapping tokens:", error);
            throw error
        }
    }

    /**
     * Simple swap method for direct token swaps
     * @param tokenInIs0 - true if swapping token0 for token1, false if swapping token1 for token0
     * @param amountIn - Amount of input token to swap (in token's smallest unit)
     * @returns Promise resolving to the transaction hash
     */
    async swap(tokenInIs0: boolean, amountIn: bigint): Promise<string> {
        console.log(`💱 Simple swap: ${tokenInIs0 ? UNISWAP_CFG.token0Symbol : UNISWAP_CFG.token1Symbol} -> ${tokenInIs0 ? UNISWAP_CFG.token1Symbol : UNISWAP_CFG.token0Symbol}`);
        console.log(`   Amount in: ${ethers.formatUnits(amountIn, tokenInIs0 ? UNISWAP_CFG.token0Decimals : UNISWAP_CFG.token1Decimals)}`);
        
        // Get quote to estimate output and set minimum
        let minOut = 0n;
        if (this.quoter) {
            try {
                const tokenInAddr = tokenInIs0 ? UNISWAP_CFG.token0 : UNISWAP_CFG.token1;
                const tokenOutAddr = tokenInIs0 ? UNISWAP_CFG.token1 : UNISWAP_CFG.token0;
                const quoteExactInputSingle = this.quoter.getFunction("quoteExactInputSingle");
                const quotedRaw = await quoteExactInputSingle.staticCall({
                    tokenIn: tokenInAddr,
                    tokenOut: tokenOutAddr,
                    amountIn,
                    fee: UNISWAP_CFG.fee,
                    sqrtPriceLimitX96: 0,
                });
                const rawAmountOut = (quotedRaw as any)?.amountOut ?? (Array.isArray(quotedRaw) ? quotedRaw[0] : (quotedRaw as any)?.[0] ?? quotedRaw);
                if (rawAmountOut !== undefined) {
                    const amountOutBigInt = this.coerceToBigInt(rawAmountOut, "quoter.quoteExactInputSingle amountOut");
                    // Apply 1% slippage tolerance
                    minOut = (amountOutBigInt * 99n) / 100n;
                    console.log(`   Expected out: ${ethers.formatUnits(amountOutBigInt, tokenInIs0 ? UNISWAP_CFG.token1Decimals : UNISWAP_CFG.token0Decimals)}`);
                    console.log(`   Min out (1% slippage): ${ethers.formatUnits(minOut, tokenInIs0 ? UNISWAP_CFG.token1Decimals : UNISWAP_CFG.token0Decimals)}`);
                }
            } catch (error) {
                console.warn("⚠️ Could not get quote, proceeding without minimum output check");
            }
        }
        
        return await this.swapExactInputSingle(tokenInIs0, amountIn, minOut);
    }

    /**
     * Validates a swap transaction by fetching and decoding the transaction receipt
     * @param txHash - Transaction hash of the swap transaction
     * @param expectedAmountIn - Optional expected input amount (for validation)
     * @param expectedAmountOut - Optional expected output amount (for validation)
     * @param expectedTokenInIs0 - Optional expected swap direction (for validation)
     * @returns Promise resolving to swap validation results
     */
    async validateSwap(
        txHash: string,
        expectedAmountIn?: bigint,
        expectedAmountOut?: bigint,
        expectedTokenInIs0?: boolean
    ): Promise<SwapValidationResult> {
        console.log(`🔍 Validating swap transaction: ${txHash}`);
        
        const result: SwapValidationResult = {
            isValid: false,
            transactionHash: txHash,
            blockNumber: 0,
            tokenInIs0: false,
            amountIn: 0n,
            amountOut: 0n,
            tokenInAddress: "",
            tokenOutAddress: "",
            poolAddress: "",
            recipient: "",
            errors: [],
            warnings: [],
        };

        try {
            // Fetch transaction receipt
            const receipt = await this.provider.getTransactionReceipt(txHash);
            if (!receipt) {
                result.errors!.push("Transaction receipt not found");
                return result;
            }

            if (receipt.status === 0) {
                result.errors!.push("Transaction reverted");
                return result;
            }

            result.blockNumber = receipt.blockNumber;
            console.log(`✅ Transaction found at block ${result.blockNumber}`);

            // Get pool address
            const poolAddress = await this.factory.getPool(
                UNISWAP_CFG.token0,
                UNISWAP_CFG.token1,
                UNISWAP_CFG.fee
            );
            
            if (!poolAddress || poolAddress === ethers.ZeroAddress) {
                result.errors!.push("Pool not found for configured token pair and fee");
                return result;
            }

            result.poolAddress = poolAddress;
            console.log(`📍 Pool address: ${poolAddress}`);

            // Create pool contract interface for decoding Swap events
            const poolInterface = new ethers.Interface(V3_POOL_ABI);

            // Find and decode Swap event from logs
            let swapEventFound = false;
            for (const log of receipt.logs) {
                // Check if log is from the pool contract
                if (log.address.toLowerCase() !== poolAddress.toLowerCase()) {
                    continue;
                }

                try {
                    // Try to decode as Swap event
                    const parsedLog = poolInterface.parseLog(log);
                    if (parsedLog && parsedLog.name === "Swap") {
                        swapEventFound = true;
                        const args = parsedLog.args;

                        // Extract swap amounts (amount0 and amount1 are int256, can be negative)
                        const amount0 = this.coerceToBigInt(args.amount0, "Swap event amount0");
                        const amount1 = this.coerceToBigInt(args.amount1, "Swap event amount1");

                        // Determine swap direction based on which amount is positive
                        // If amount0 > 0 and amount1 < 0: swapping token0 for token1 (token0 -> token1)
                        // If amount0 < 0 and amount1 > 0: swapping token1 for token0 (token1 -> token0)
                        const tokenInIs0 = amount0 > 0n && amount1 < 0n;
                        const tokenOutIs0 = amount0 < 0n && amount1 > 0n;

                        if (!tokenInIs0 && !tokenOutIs0) {
                            result.warnings!.push("Unable to determine swap direction from event amounts");
                            continue;
                        }

                        result.tokenInIs0 = tokenInIs0;
                        result.tokenInAddress = tokenInIs0 ? UNISWAP_CFG.token0 : UNISWAP_CFG.token1;
                        result.tokenOutAddress = tokenInIs0 ? UNISWAP_CFG.token1 : UNISWAP_CFG.token0;
                        result.recipient = args.recipient;

                        // Convert to absolute values for amountIn and amountOut
                        result.amountIn = tokenInIs0 ? amount0 : amount1;
                        result.amountOut = tokenInIs0 ? -amount1 : -amount0;

                        console.log(`📊 Swap event decoded:`);
                        console.log(`   Direction: ${tokenInIs0 ? UNISWAP_CFG.token0Symbol : UNISWAP_CFG.token1Symbol} -> ${tokenInIs0 ? UNISWAP_CFG.token1Symbol : UNISWAP_CFG.token0Symbol}`);
                        console.log(`   Amount In: ${ethers.formatUnits(result.amountIn, tokenInIs0 ? UNISWAP_CFG.token0Decimals : UNISWAP_CFG.token1Decimals)} ${tokenInIs0 ? UNISWAP_CFG.token0Symbol : UNISWAP_CFG.token1Symbol}`);
                        console.log(`   Amount Out: ${ethers.formatUnits(result.amountOut, tokenInIs0 ? UNISWAP_CFG.token1Decimals : UNISWAP_CFG.token0Decimals)} ${tokenInIs0 ? UNISWAP_CFG.token1Symbol : UNISWAP_CFG.token0Symbol}`);
                        console.log(`   Recipient: ${result.recipient}`);
                        console.log(`   Transaction: https://sepolia.etherscan.io/tx/${txHash}`);
                        break; // Found the Swap event, exit loop
                    }
                } catch (parseError) {
                    // Not a Swap event, continue searching
                    continue;
                }
            }

            if (!swapEventFound) {
                result.errors!.push("No Swap event found in transaction logs");
                return result;
            }

            // Validate against expected values if provided
            if (expectedAmountIn !== undefined) {
                if (result.amountIn !== expectedAmountIn) {
                    result.errors!.push(
                        `Amount in mismatch: expected ${expectedAmountIn.toString()}, got ${result.amountIn.toString()}`
                    );
                }
            }

            if (expectedAmountOut !== undefined) {
                // Allow 1% tolerance for slippage
                const tolerance = (result.amountOut * 1n) / 100n;
                const minExpected = expectedAmountOut - tolerance;
                
                if (result.amountOut < minExpected) {
                    result.errors!.push(
                        `Amount out below expected (with 1% tolerance): expected >= ${minExpected.toString()}, got ${result.amountOut.toString()}`
                    );
                }
            }

            if (expectedTokenInIs0 !== undefined) {
                if (result.tokenInIs0 !== expectedTokenInIs0) {
                    result.errors!.push(
                        `Swap direction mismatch: expected ${expectedTokenInIs0 ? UNISWAP_CFG.token0Symbol : UNISWAP_CFG.token1Symbol}, got ${result.tokenInIs0 ? UNISWAP_CFG.token0Symbol : UNISWAP_CFG.token1Symbol}`
                    );
                }
            }

            // Also check if transaction was sent to the router
            const tx = await this.provider.getTransaction(txHash);
            if (tx && tx.to) {
                if (tx.to.toLowerCase() !== (this.router.target as string).toLowerCase()) {
                    result.warnings!.push(`Transaction not sent to configured router: ${tx.to}`);
                }
            }

            // Mark as valid if no errors found
            result.isValid = result.errors!.length === 0;

            if (result.isValid) {
                console.log(`✅ Swap validation passed`);
            } else {
                console.log(`❌ Swap validation failed:`, result.errors);
            }

            return result;
        } catch (error: any) {
            result.errors!.push(`Error validating swap: ${error.message || String(error)}`);
            console.error("❌ Error validating swap:", error);
            return result;
        }
    }
}


