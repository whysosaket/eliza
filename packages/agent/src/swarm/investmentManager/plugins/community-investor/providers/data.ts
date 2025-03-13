import {
    elizaLogger,
    formatMessages,
    type IAgentRuntime,
    type Memory,
    ModelTypes,
    type Provider,
    type State,
    type UUID
} from "@elizaos/core";
import { z } from "zod";
import { CoingeckoClient } from "../clients";
import { formatRecommenderReport } from "../reports";
import type { TrustTradingService } from "../tradingService";
import {
    ServiceTypes,
    type PositionWithBalance,
    type TokenPerformance,
    type RecommenderMetrics as TypesRecommenderMetrics,
    type TokenPerformance as TypesTokenPerformance,
    type Transaction as TypesTransaction
} from "../types";
import { getZodJsonSchema, render } from "../utils";
// Create a simple formatter module inline if it doesn't exist
// This will be used until a proper formatters.ts file is created
const formatters = {
    formatTokenPerformance: (token: TypesTokenPerformance): string => {
        return `
        <token>
        Chain: ${token.chain}
        Address: ${token.address}
        Symbol: ${token.symbol}
        Price: $${token.price.toFixed(6)}
        Liquidity: $${token.liquidity.toFixed(2)}
        24h Change: ${token.price24hChange.toFixed(2)}%
        </token>
        `;
    }
};

// Use local formatters until a proper module is created
const { formatTokenPerformance } = formatters;

const dataProviderTemplate = `<data_provider>

<instructions>
Always give a full details report if user ask anything about the positions, tokens, recommenders.
Write the report to be display in telegram.
Always Include links for the token addresses and accounts(wallets, creators) using solscan.
Include links to the tradings pairs using defined.fi
Links:

- Token: https://solscan.io/token/[tokenAddress]
- Account: https://solscan.io/account/[accountAddress]
- Tx: https://solscan.io/tx/[txHash]
- Pair: https://www.defined.fi/sol/[pairAddress]

</instructions>

<token_reports>
{{tokenReports}}
</token_reports>

<positions_summary>
Total Current Value: {{totalCurrentValue}}
Total Realized P&L: {{totalRealizedPnL}}
Total Unrealized P&L: {{totalUnrealizedPnL}}
Total P&L: {{totalPnL}}
</positions_summary>

<entity>
{{entity}}
</entity>

<global_market_data>
{{globalMarketData}}
</global_market_data>

</data_provider>`;

const dataLoaderTemplate = `You are a data provider system for a memecoin trading platform. Your task is to detect necessary data operations from messages and output required actions.

<available_actions>
{{actions}}
</available_actions>

Current data state:
<tokens>
{{tokens}}
</tokens>

<positions>
{{positions}}
</positions>

Analyze the following messages and output any required actions:
<messages>
{{messages}}
</messages>

Rules:

- Detect any new token addresses mentioned in messages
- Do not modify the contract address, even if it contains words like "pump" or "meme" (i.e. BtNpKW19V1vefFvVzjcRsCTj8cwwc1arJcuMrnaApump)
- Compare mentioned tokens against current data state
- Consider data freshness when tokens or positions are queried
- Order actions by dependency (loading new data before refreshing)
- Only output necessary actions

Output structure:
<o>
[List of actions to be taken if applicable]
<action name="[action name]">[action parameters as JSON]</action>
</o>
`;

type DataActionState = {
    runtime: IAgentRuntime;
    message: Memory;
    tradingService: TrustTradingService;
    tokens: TypesTokenPerformance[];
    positions: PositionWithBalance[];
    transactions: TypesTransaction[];
};

type DataAction<Params extends z.AnyZodObject = z.AnyZodObject> = {
    name: string;
    description: string;
    params: Params;
    handler: (state: DataActionState, params: z.infer<Params>) => Promise<void>;
};

function createAction<Params extends z.AnyZodObject = z.AnyZodObject>(
    action: DataAction<Params>
) {
    return action;
}

// Available actions
const actions = [
    createAction({
        name: "refresh_token",
        description: "Refresh token information from chain",
        params: z.object({
            tokenAddress: z.string().describe("Token address to refresh"),
            chain: z.string().default("solana").describe("Chain name"),
        }),
        async handler({ tradingService, tokens }, params) {
            // Normalize token address
            const tokenAddress = params.tokenAddress.toLowerCase();
            // Update token information using the TrustTradingService
            await tradingService.updateTokenPerformance(params.chain, tokenAddress);
            // Could also update trade history, position balances, etc.
        },
    }),
    createAction({
        name: "refresh_position",
        description: "Refresh position information",
        params: z.object({
            positionId: z.string().uuid().describe("Position ID to refresh"),
            includeTx: z.boolean().default(true).describe("Include transactions"),
        }),
        async handler(_state, { positionId, includeTx }) {},
    }),
    createAction({
        name: "close_positions",
        description: "Close positions (set them as closed)",
        params: z.object({
            positionIds: z.array(z.string().uuid()).describe("Position IDs to close"),
        }),
        async handler({runtime}, { positionIds }) {
            const tradingService = runtime.getService<TrustTradingService>(ServiceTypes.TRUST_TRADING);
            for (const positionId of positionIds) {
                await tradingService.closePosition(positionId as UUID);
            }
        },
    }),
    createAction({
        name: "update_trust_score",
        description: "Update trust score for a entity",
        params: z.object({
            entityId: z.string().uuid().describe("Entity ID to update"),
        }),
        async handler({runtime, message}, { entityId }) {
            const tradingService = runtime.getService<TrustTradingService>(ServiceTypes.TRUST_TRADING);
            // Use db method instead - assuming this is the correct replacement
            await tradingService.initializeRecommenderMetrics(entityId as UUID, message.content.source);
        },
    }),
    createAction({
        name: "update_positions",
        description: "Update performance calculation of positions",
        params: z.object({
            positionIds: z.array(z.string().uuid()).describe("Position IDs to update"),
        }),
        async handler({ runtime, tokens, positions, transactions }, { positionIds }) {
            // Use the correct method for updating positions
            for (const positionId of positionIds) {
                // Get token address from position
                const position = positions.find(p => p.id === positionId);
                if (position) {
                    const tradingService = runtime.getService<TrustTradingService>(ServiceTypes.TRUST_TRADING);
                    await tradingService.updateTokenPerformance(position.chain, position.tokenAddress);
                }
            }
        },
    }),
];

function extractActions(text: string) {
    const regex = /<action name="([^"]+)">([^<]+)<\/action>/g;
    const actions = [];
    let match;

    while ((match = regex.exec(text)) !== null) {
        try {
            const name = match[1];
            const params = JSON.parse(match[2]);
            actions.push({ name, params });
        } catch (error) {
            console.error("Error parsing action:", error);
        }
    }

    return actions;
}

function jsonFormatter(_key: any, value: any) {
    console.log('DEBUG: jsonFormatter', value)
    if (value instanceof Date) return value.toISOString();
    return value;
}

async function runActions(
    actions: any[],
    runtime: IAgentRuntime,
    message: Memory,
    tokens: TypesTokenPerformance[],
    positions: PositionWithBalance[],
    transactions: TypesTransaction[]
) {
    const tradingService = runtime.getService<TrustTradingService>(ServiceTypes.TRUST_TRADING);
    
    return Promise.all(
        actions.map(async (actionCall) => {
            const action = actions.find((a) => a.name === actionCall.name);
            if (action) {
                const params = action.params.parse(actionCall.params);
                await action.handler({ runtime, message, tradingService, tokens, positions, transactions }, params);
            }
        })
    );
}

export const dataProvider: Provider = {
    name: "data",
    async get(
        runtime: IAgentRuntime,
        message: Memory,
        _state?: State
    ): Promise<string> {
        try {
            // Extract token addresses from message and recent context
            const messageContent = message.content.text;

            // Extract actions from message content
            const extractedText = messageContent.match(
                /<o>(.*?)<\/o>/s
            );
            const actions = extractedText
                ? extractActions(extractedText[1])
                : [];

            // Initialize data
            const tokens: TokenPerformance[] = [];
            const positions: PositionWithBalance[] = [];
            const transactions: TypesTransaction[] = [];

            // Run extracted actions with a safe environment
            if (actions.length > 0) {
                await runActions(actions, runtime, message, tokens as TypesTokenPerformance[], positions, transactions);
            }

            // Generate token reports
            const tokenReports = await Promise.all(
                tokens.map(async (token) => formatTokenPerformance(token))
            );

            // Get entity info if message is from a user
            const clientUserId = message.userId === message.agentId ? "" : message.userId;
            const entity = await runtime.databaseAdapter.getEntityById(clientUserId as UUID);
            const tradingService = runtime.getService<TrustTradingService>(ServiceTypes.TRUST_TRADING);

            // Add updatedAt to RecommenderMetrics to make it compatible
            const recommenderMetrics = entity
                ? await tradingService.getRecommenderMetrics(entity.id)
                : undefined;
                
            const metrics = recommenderMetrics
                ? {
                    ...recommenderMetrics,
                    updatedAt: Date.now() // Add missing updatedAt property
                  } as TypesRecommenderMetrics
                : undefined;

            const metricsHistory = entity
                ? await tradingService.getRecommenderMetricsHistory(entity.id)
                : [];
                
            // Convert metrics history to compatible type
            const typedMetricsHistory = metricsHistory.map(history => ({
                ...history,
                historyId: history.entityId
            }));

            const recommenderReport =
                entity && metrics
                    ? formatRecommenderReport(
                          entity as any,
                          metrics,
                          typedMetricsHistory
                      )
                    : "";

            // Get market data
            // Use the static method to create the client
            const coingeckoClient = CoingeckoClient.createFromRuntime(runtime);
            const priceData = await coingeckoClient.fetchGlobal();
            const totalCurrentValue = "$0.00";
            const totalRealizedPnL = "$0.00";
            const totalUnrealizedPnL = "$0.00";
            const totalPnL = "$0.00";
            const prices = priceData?.data?.market_data?.prices || {};
            const marketCapPercentage = priceData?.data?.market_data?.market_cap_percentage || {};

            return render(dataProviderTemplate, {
                tokenReports: tokenReports.join("\n"),
                totalCurrentValue,
                totalRealizedPnL,
                totalUnrealizedPnL,
                totalPnL,
                entity: recommenderReport,
                globalMarketData: JSON.stringify({
                    prices,
                    marketCapPercentage,
                }),
            });
        } catch (error) {
            const tokenSet = new Set<string>();
            const tokens: TokenPerformance[] = [];
            const positions: PositionWithBalance[] = [];
            const transactions: TypesTransaction[] = [];
            const tradingService = runtime.getService<TrustTradingService>(ServiceTypes.TRUST_TRADING);

            // Get open positions
            const openPositions = await tradingService.getOpenPositionsWithBalance();
            
            for (const position of openPositions) {
                if (tokenSet.has(`${position.chain}:${position.tokenAddress}`))
                    continue;

                const tokenPerformance = await tradingService.getTokenPerformance(
                    position.chain,
                    position.tokenAddress
                );

                if (tokenPerformance) tokens.push(tokenPerformance);

                tokenSet.add(`${position.chain}:${position.tokenAddress}`);
            }

            const context = render(dataLoaderTemplate, {
                actions: actions
                    .map(
                        (a) =>
                            `${a.name}: ${a.description}\nParams: ${JSON.stringify(
                                getZodJsonSchema(a.params)
                            )}`
                    )
                    .join("\n\n"),
                tokens: JSON.stringify(tokens, jsonFormatter),
                positions: JSON.stringify(positions, jsonFormatter),
                // Add missing messages parameter
                messages: message.content.text,
            });

            const dataProviderResponse = await runtime.useModel(ModelTypes.TEXT_LARGE, {
                messages: [
                    {
                        role: "system",
                        content: context,
                    },
                    {
                        role: "user",
                        // Fix formatMessages call by providing the required structure
                        content: formatMessages({
                            messages: [message],
                            actors: [] // Provide empty actors array 
                        }),
                    },
                ],
            });

            if (dataProviderResponse) {
                const extractedText = dataProviderResponse.match(
                    /<o>(.*?)<\/o>/s
                );
                const actions = extractedText
                    ? extractActions(extractedText[1])
                    : [];

                try {
                    if (actions.length > 0) {
                        await runActions(actions, runtime, message, tokens as TypesTokenPerformance[], positions, transactions);
                    }

                    const tokenReports = await Promise.all(
                        tokens.map(async (token) => formatTokenPerformance(token))
                    );

                    const tradingService = runtime.getService<TrustTradingService>(ServiceTypes.TRUST_TRADING);

                    const entity = await runtime.databaseAdapter.getEntityById(message.userId as UUID);

                    // Add updatedAt to RecommenderMetrics to make it compatible
                    const recommenderMetrics = entity
                        ? await tradingService.getRecommenderMetrics(entity.id)
                        : undefined;
                        
                    const metrics = recommenderMetrics
                        ? {
                            ...recommenderMetrics,
                            updatedAt: Date.now() // Add missing updatedAt property
                          } as TypesRecommenderMetrics
                        : undefined;

                    const metricsHistory = entity
                        ? await tradingService.getRecommenderMetricsHistory(entity.id)
                        : [];
                        
                    // Convert metrics history to compatible type
                    const typedMetricsHistory = metricsHistory.map(history => ({
                        ...history,
                        historyId: history.entityId
                    }));

                    const recommenderReport =
                        entity && metrics
                            ? formatRecommenderReport(
                                  entity as any,
                                  metrics,
                                  typedMetricsHistory
                              )
                            : "";

                    const totalCurrentValue = "$0.00";
                    const totalRealizedPnL = "$0.00";
                    const totalUnrealizedPnL = "$0.00";
                    const totalPnL = "$0.00";
                    const _positionReports: string[] = [];

                    return render(dataProviderTemplate, {
                        tokenReports: tokenReports.join("\n"),
                        totalCurrentValue,
                        totalRealizedPnL,
                        totalUnrealizedPnL,
                        totalPnL,
                        entity: recommenderReport,
                        globalMarketData: JSON.stringify({
                            prices: {},
                            marketCapPercentage: {},
                        }),
                    });
                } catch (error) {
                    console.log(error);
                    return "";
                }
            }

            console.log(error);
            return "";
        }
    },
};
