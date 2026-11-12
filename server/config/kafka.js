/**
 * Kafka Client Configuration
 *
 * Provides a singleton Kafka client, shared producer, and consumer factory.
 * Uses KafkaJS with automatic topic creation and retry defaults.
 */

const { Kafka, logLevel } = require("kafkajs");
const logger = require("../utils/logger");

// ─── Kafka Broker Config ────────────────────────────────────────────────────
const BROKERS = (process.env.KAFKA_BROKERS || "localhost:9092").split(",");
const CLIENT_ID = process.env.KAFKA_CLIENT_ID || "mail-or-a-server";

const kafkaConfig = {
  clientId: CLIENT_ID,
  brokers: BROKERS,
  logLevel: logLevel.WARN,
  retry: {
    initialRetryTime: 300,
    retries: 10,
  },
};

// Cloud Kafka (Upstash / Confluent Cloud / Aiven) support with SASL & SSL
if (process.env.KAFKA_USERNAME && process.env.KAFKA_PASSWORD) {
  const rejectUnauthorized = process.env.KAFKA_REJECT_UNAUTHORIZED === "true";
  kafkaConfig.ssl = { rejectUnauthorized };
  kafkaConfig.sasl = {
    mechanism: process.env.KAFKA_SASL_MECHANISM || "scram-sha-256",
    username: process.env.KAFKA_USERNAME,
    password: process.env.KAFKA_PASSWORD,
  };
} else if (process.env.KAFKA_SSL === "true") {
  kafkaConfig.ssl = true;
}

const kafka = new Kafka(kafkaConfig);

// ─── Shared Producer (singleton) ────────────────────────────────────────────
let _producer = null;

async function getProducer() {
  if (!_producer) {
    _producer = kafka.producer({
      allowAutoTopicCreation: true,
      transactionTimeout: 30000,
    });
    await _producer.connect();
    logger.info("Kafka", "Producer connected");
  }
  return _producer;
}

// ─── Consumer Factory ───────────────────────────────────────────────────────
function createConsumer(groupId) {
  return kafka.consumer({
    groupId,
    sessionTimeout: 30000,
    heartbeatInterval: 3000,
    maxWaitTimeInMs: 5000,
  });
}

// ─── Admin (for topic creation if needed) ───────────────────────────────────
async function ensureTopics(topicNames) {
  const admin = kafka.admin();
  await admin.connect();
  try {
    const existingTopics = await admin.listTopics();
    const toCreate = topicNames.filter((t) => !existingTopics.includes(t));
    if (toCreate.length > 0) {
      const replicationFactor = parseInt(
        process.env.KAFKA_REPLICATION_FACTOR || (process.env.KAFKA_USERNAME ? "2" : "1"),
        10
      );
      const numPartitions = parseInt(
        process.env.KAFKA_NUM_PARTITIONS || (process.env.KAFKA_USERNAME ? "2" : "3"),
        10
      );
      await admin.createTopics({
        topics: toCreate.map((topic) => ({
          topic,
          numPartitions,
          replicationFactor,
        })),
      });
      logger.info("Kafka", `Topics created: ${toCreate.join(", ")}`);
    }
  } finally {
    await admin.disconnect();
  }
}

// ─── Topic Constants ────────────────────────────────────────────────────────
const TOPICS = {
  EMAIL_CLASSIFICATION: "email-classification",
  EMAIL_CLASSIFICATION_DLQ: "email-classification-dlq",
  WHATSAPP_MESSAGES: "whatsapp-messages",
  WHATSAPP_MESSAGES_DLQ: "whatsapp-messages-dlq",
};

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
async function disconnectKafka() {
  if (_producer) {
    await _producer.disconnect();
    _producer = null;
    logger.info("Kafka", "Producer disconnected");
  }
}

module.exports = {
  kafka,
  getProducer,
  createConsumer,
  ensureTopics,
  disconnectKafka,
  TOPICS,
};
