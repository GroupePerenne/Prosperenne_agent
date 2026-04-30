/**
 * src/functions/davidQueueConsumer — Queue trigger v4 sur charli-events.
 *
 * Thin wrapper qui :
 *   1. enregistre le binding via app.storageQueue (Programming Model v4)
 *   2. construit (lazy) un mcpClient mémoïsé par worker
 *   3. délègue le traitement à lib/processor.processQueueItem
 *
 * La logique métier (parse, dédup, normalize, addMemory) vit dans
 * lib/processor.js — testable sans @azure/functions.
 */

'use strict';

const { app } = require('@azure/functions');
const { createTokenProvider } = require('../../lib/tokenProvider');
const { createMcpClient } = require('../../lib/mem0McpClient');
const { processQueueItem } = require('../../lib/processor');

let _mcpClient = null;

function buildMcpClient() {
  const tokenProvider = createTokenProvider({
    tenantId: process.env.ENTRA_TENANT_ID,
    clientId: process.env.ENTRA_CLIENT_ID,
    scope: process.env.ENTRA_SCOPE,
  });
  return createMcpClient({
    url: process.env.MEM0_MCP_URL,
    tokenProvider,
  });
}

function getMcpClient() {
  if (!_mcpClient) _mcpClient = buildMcpClient();
  return _mcpClient;
}

app.storageQueue('davidQueueConsumer', {
  queueName: 'charli-events',
  connection: 'AzureWebJobsStorage',
  handler: async (queueItem, context) => {
    return processQueueItem(queueItem, context, { mcpClient: getMcpClient() });
  },
});
