import { type IAgentRuntime, logger } from "@elizaos/core";
import { WalletService } from './walletService';
import { DataService } from './dataService';
import { AnalyticsService } from './analyticsService';
import { type BuySignalMessage } from '../types';
import { TradingConfig } from '../types/trading';
import { v4 as uuidv4 } from 'uuid';
import { UUID } from 'uuid';

export class BuyService {
  private tradingConfig: TradingConfig;

  constructor(
    private runtime: IAgentRuntime,
    private walletService: WalletService,
    private dataService: DataService,
    private analyticsService: AnalyticsService
  ) {
    this.tradingConfig = {
      intervals: {
        priceCheck: 60000,
        walletSync: 600000,
        performanceMonitor: 3600000,
      },
      thresholds: {
        minLiquidity: 50000,
        minVolume: 100000,
        minScore: 60,
      },
      riskLimits: {
        maxPositionSize: 0.2,
        maxDrawdown: 0.1,
        stopLossPercentage: 0.05,
        takeProfitPercentage: 0.2,
      },
      slippageSettings: {
        baseSlippage: 0.5,
        maxSlippage: 1.0,
        liquidityMultiplier: 1.0,
        volumeMultiplier: 1.0,
      },
    };
  }

  async initialize(): Promise<void> {
    logger.info("Initializing buy service");
  }

  async stop(): Promise<void> {
    // Cleanup if needed
  }

  async handleBuySignal(signal: BuySignalMessage): Promise<{
    success: boolean;
    signature?: string;
    error?: string;
    outAmount?: string;
    swapUsdValue?: string;
  }> {
    try {
      // Validate token before trading
      const validation = await this.validateTokenForTrading(signal.tokenAddress);
      if (!validation.isValid) {
        return { success: false, error: validation.reason };
      }

      // Calculate optimal buy amount
      const walletBalance = await this.walletService.getBalance();
      const buyAmount = await this.calculateOptimalBuyAmount({
        tokenAddress: signal.tokenAddress,
        walletBalance,
        signal,
      });

      if (buyAmount <= 0) {
        return { success: false, error: "Buy amount too small" };
      }

      // Calculate dynamic slippage
      const slippageBps = await this.calculateDynamicSlippage(
        signal.tokenAddress,
        buyAmount,
        false
      );

      // Get wallet instance
      const wallet = await this.walletService.getWallet();

      // Execute buy
      const result = await wallet.buy({
        tokenAddress: signal.tokenAddress,
        amountInSol: buyAmount,
        slippageBps,
      });

      if (result.success && result.outAmount) {
        // Track slippage impact
        await this.analyticsService.trackSlippageImpact(
          signal.tokenAddress,
          signal.expectedAmount || "0",
          result.outAmount,
          slippageBps,
          false
        );
      }

      return result;
    } catch (error) {
      logger.error("Error handling buy signal:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async validateTokenForTrading(tokenAddress: string): Promise<{
    isValid: boolean;
    reason?: string;
  }> {
    try {
      // Get token market data
      const marketData = await this.dataService.getTokenMarketData(tokenAddress);

      // Check if token has sufficient liquidity
      if (marketData.liquidity < this.tradingConfig.thresholds.minLiquidity) {
        return {
          isValid: false,
          reason: `Insufficient liquidity: ${marketData.liquidity} < ${this.tradingConfig.thresholds.minLiquidity}`,
        };
      }

      // Check if token has sufficient volume
      if (marketData.volume24h < this.tradingConfig.thresholds.minVolume) {
        return {
          isValid: false,
          reason: `Insufficient 24h volume: ${marketData.volume24h} < ${this.tradingConfig.thresholds.minVolume}`,
        };
      }

      // Fetch token metadata
      const tokenMetadata = await this.fetchTokenMetadata(tokenAddress);

      // Additional validations
      if (!tokenMetadata.verified) {
        return { isValid: false, reason: "Token is not verified" };
      }

      if (tokenMetadata.suspiciousAttributes.length > 0) {
        return {
          isValid: false,
          reason: `Suspicious attributes: ${tokenMetadata.suspiciousAttributes.join(", ")}`,
        };
      }

      return { isValid: true };
    } catch (error) {
      logger.error("Error validating token:", error);
      return {
        isValid: false,
        reason: `Validation error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async calculateOptimalBuyAmount({
    tokenAddress,
    walletBalance,
    signal,
  }: {
    tokenAddress: string;
    walletBalance: number;
    signal: BuySignalMessage;
  }): Promise<number> {
    try {
      // Get token data
      const tokenData = await this.dataService.getTokenMarketData(tokenAddress);

      // Calculate base position size based on wallet balance and risk limits
      const maxPosition = walletBalance * this.tradingConfig.riskLimits.maxPositionSize;
      
      // Adjust for volatility
      let adjustedAmount = maxPosition;
      if (tokenData.priceHistory) {
        const volatility = this.calculateVolatility(tokenData.priceHistory);
        const volatilityFactor = Math.max(0.5, 1 - volatility);
        adjustedAmount *= volatilityFactor;
      }

      // Adjust for market conditions
      const marketCondition = await this.assessMarketCondition();
      if (marketCondition === "bearish") {
        adjustedAmount *= 0.5;
      }

      // Ensure we don't exceed liquidity constraints
      const maxLiquidityImpact = tokenData.liquidity * 0.02; // Max 2% of liquidity
      const finalAmount = Math.min(adjustedAmount, maxLiquidityImpact);

      // Ensure minimum trade size
      const minTradeSize = 0.05; // Minimum 0.05 SOL
      return Math.max(minTradeSize, finalAmount);
    } catch (error) {
      logger.error("Error calculating optimal buy amount:", error);
      return 0;
    }
  }

  private async calculateDynamicSlippage(
    tokenAddress: string,
    tradeAmount: number,
    isSell: boolean
  ): Promise<number> {
    try {
      const tokenData = await this.dataService.getTokenMarketData(tokenAddress);

      // Start with base slippage
      let slippage = this.tradingConfig.slippageSettings.baseSlippage;

      // Adjust for liquidity
      const liquidityPercentage = (tradeAmount / tokenData.liquidity) * 100;
      if (liquidityPercentage > 0.1) {
        const liquidityFactor = liquidityPercentage ** 1.5 * this.tradingConfig.slippageSettings.liquidityMultiplier;
        slippage += liquidityFactor * 0.01;
      }

      // Adjust for volume
      const volumeToMcapRatio = tokenData.volume24h / tokenData.marketCap;
      if (volumeToMcapRatio > 0.05) {
        const volumeDiscount = Math.min(volumeToMcapRatio * 5, 0.5) * this.tradingConfig.slippageSettings.volumeMultiplier;
        slippage = Math.max(slippage - volumeDiscount, this.tradingConfig.slippageSettings.baseSlippage * 0.5);
      }

      // Cap at maximum allowed slippage
      const finalSlippage = Math.min(slippage, this.tradingConfig.slippageSettings.maxSlippage);

      // Convert to basis points
      return Math.floor(finalSlippage * 100);
    } catch (error) {
      logger.error("Error calculating dynamic slippage:", error);
      return 100; // Default to 1% slippage
    }
  }

  private calculateVolatility(priceHistory: number[]): number {
    if (priceHistory.length < 2) return 0;

    const returns = [];
    for (let i = 1; i < priceHistory.length; i++) {
      returns.push(Math.log(priceHistory[i] / priceHistory[i - 1]));
    }

    const mean = returns.reduce((a, b) => a + b) / returns.length;
    const variance = returns.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / returns.length;
    return Math.sqrt(variance);
  }

  private async assessMarketCondition(): Promise<"bullish" | "neutral" | "bearish"> {
    try {
      const solData = await this.dataService.getTokenMarketData(
        "So11111111111111111111111111111111111111112" // SOL address
      );

      if (!solData.priceHistory || solData.priceHistory.length < 24) {
        return "neutral";
      }

      const currentPrice = solData.price;
      const previousPrice = solData.priceHistory[0];
      const priceChange = ((currentPrice - previousPrice) / previousPrice) * 100;

      if (priceChange > 5) return "bullish";
      if (priceChange < -5) return "bearish";
      return "neutral";
    } catch (error) {
      logger.error("Error assessing market condition:", error);
      return "neutral";
    }
  }

  private async fetchTokenMetadata(tokenAddress: string): Promise<{
    verified: boolean;
    suspiciousAttributes: string[];
    ownershipConcentration: number;
  }> {
    // Implementation from previous code...
    // This would fetch token metadata from your preferred source
    return {
      verified: true,
      suspiciousAttributes: [],
      ownershipConcentration: 0,
    };
  }

  async generateBuySignal(): Promise<void> {
    try {
      logger.info("Generating buy signal...");

      // Get token recommendation
      const recommendation = await this.dataService.getTokenRecommendation();

      if (!recommendation) {
        logger.info("No token recommendation available");
        return;
      }

      logger.info("Token recommendation:", recommendation);

      // Create buy signal
      const signal: BuySignalMessage = {
        positionId: uuidv4() as UUID,
        tokenAddress: recommendation.recommend_buy_address,
        entityId: "default",
      };

      // Create buy task with the recommended amount
      await this.createBuyTask(signal, recommendation.buy_amount);
    } catch (error) {
      logger.error("Error generating buy signal:", error);
    }
  }

  private async analyzeTradingAmount({
    walletBalance,
    tokenAddress,
    defaultPercentage = 0.1,
  }: {
    walletBalance: number;
    tokenAddress: string;
    defaultPercentage?: number;
  }): Promise<number> {
    try {
      // Log input parameters
      logger.info("Starting trade analysis with:", {
        walletBalance,
        tokenAddress,
        defaultPercentage,
      });

      // Get token recommendation from data service
      const tokenRecommendation = await this.dataService.getTokenRecommendation();

      // ... rest of the analysis logic ...
      const suggestedAmount = tokenRecommendation.buy_amount || walletBalance * defaultPercentage;
      
      logger.info("Final suggested amount:", { suggestedAmount });
      return Math.min(suggestedAmount, walletBalance);
    } catch (error) {
      logger.error("Trade analysis failed:", {
        error: error instanceof Error ? error.message : "Unknown error",
        stack: error instanceof Error ? error.stack : undefined,
      });
      return walletBalance * defaultPercentage;
    }
  }
} 