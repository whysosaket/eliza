// todo: replace Client reference with client reference
// Set up cache adapter for loading cookies
// This action should be able to run on a schedule
// store tweets as memories in db, no reason really to get twitter here

import { type IAgentRuntime, ServiceTypes, logger, createUniqueUuid, type UUID, ChannelType } from "@elizaos/core";

export default class Twitter {
  runtime: IAgentRuntime;
  feedRoomId: UUID;

  constructor(runtime: IAgentRuntime) {
    this.runtime = runtime;
    // Create a consistent room ID for the twitter feed
    this.feedRoomId = createUniqueUuid(runtime, "twitter-feed");
  }

  async syncRawTweets(): Promise<boolean> {
    console.log('syncRawTweets')
    try {
      const username = this.runtime.getSetting("TWITTER_USERNAME");

      // Ensure feed room exists
      await this.runtime.ensureRoomExists({
        id: this.feedRoomId,
        name: "Twitter Feed",
        source: "twitter",
        type: ChannelType.FEED
      });
      console.log('')

      // get the twitterClient from runtime
      const twitterClient = this.runtime.getService(ServiceTypes.TWITTER);
      if (!twitterClient) {
        logger.error("Twitter client not found");
        return false;
      }

      const list = twitterClient.getTweets(username as string, 200);
      console.log('list', list.length)
      let syncCount = 0;

      for (const item of list) {
        if (item?.text && !item?.isRetweet) {
          const tweetId = createUniqueUuid(this.runtime, item.id);

          // Check if we already have this tweet
          const existingTweet = await this.runtime.messageManager.getMemoryById(tweetId);
          if (existingTweet) {
            continue;
          }

          // Create memory for the tweet
          console.log('creating tweet memory')
          await this.runtime.messageManager.createMemory({
            id: tweetId,
            userId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            content: {
              text: item.text,
              source: "twitter",
              metadata: {
                likes: item.likes ?? 0,
                retweets: item.retweets ?? 0,
                username: item.username,
                timestamp: new Date(item.timestamp * 1000).toISOString()
              }
            },
            roomId: this.feedRoomId,
            createdAt: item.timestamp * 1000
          });

          syncCount++;
        }
      }

      logger.info(`Raw tweet sync [username: ${username}] synced ${syncCount} new tweets`);

      /** Sleep 10 seconds */
      await new Promise(resolve => setTimeout(resolve, 10 * 1000));

      return true;
    } catch (error) {
      console.error('error syncing tweets', error)
      logger.error("Error syncing tweets:", error);
      return false;
    }
  }
}
