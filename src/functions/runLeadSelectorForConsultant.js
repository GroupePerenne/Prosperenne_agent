/**
 * POST /api/runLeadSelectorForConsultant
 *
 * Re-déclenche le pipeline complet (sélection candidates + enrichissement
 * exhauster + lancement séquence) pour un consultant déjà connu (brief
 * stocké dans Mem0). Usage : Paul via curl/Postman, Charli plus tard,
 * cockpit futur.
 *
 * Body attendu :
 * {
 *   "consultantId": "morgane.dupont@oseys.fr",   // email lowercased, requis
 *   "batchSize":    10,                          // optionnel, défaut env
 *   "dryRun":       true                         // optionnel : retourne le
 *                                                  batch SANS lancer la séquence
 *                                                  ET skip Dropcontact (simulated)
 * }
 *
 * Mis à jour au Jalon 3 pour consommer `enrichBatchForConsultant` qui
 * intègre la boucle exhauster. L'ancien flow `selectLeadsForConsultantById`
 * reste disponible pour test / fallback mais n'est plus appelé ici.
 */

const { app } = require('@azure/functions');
const { parseBriefFromMemories } = require('../../shared/leadSelector');
const { launchSequenceForConsultant } = require('../../agents/david/orchestrator');
const { getMem0 } = require('../../shared/adapters/memory/mem0');
const { enrichAndProfileBatchForConsultant } = require('../../shared/enrichAndProfileBatch');
const { buildInsufficientBatchMail } = require('../../shared/lead-exhauster/enrichBatch');
const { sendMail } = require('../../shared/graph-mail');
const { makeSafeLogger } = require('../../shared/safe-log');
const { QueueClient, QueueServiceClient } = require('@azure/storage-queue');
const { randomUUID } = require('node:crypto');

const DEFAULT_BATCH_SIZE = Number(process.env.LEAD_SELECTOR_BATCH_SIZE || 10);
const QUEUE_NAME = 'lead-selector-jobs';

app.http('runLeadSelectorForConsultant', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    const log = makeSafeLogger(context);
    try {
      const body = await request.json().catch(() => ({}));
      const { consultantId, batchSize = DEFAULT_BATCH_SIZE, dryRun = false, async: asyncMode = false } = body;
      if (!consultantId) {
        return {
          status: 400,
          jsonBody: { error: 'consultantId requis (email lowercased)' },
        };
      }

      // Mode async : poste le job en queue et retourne 202 immédiatement.
      // Recommandé pour les pipelines longs (>200s) qui timeoutaient en mode
      // synchrone HTTP. Le handler queue trigger leadSelectorJobQueue
      // consomme et exécute en background (timeout 10 min).
      if (asyncMode === true) {
        const jobId = `job-${Date.now()}-${randomUUID().slice(0, 8)}`;
        try {
          const queueClient = new QueueClient(process.env.AzureWebJobsStorage, QUEUE_NAME);
          await queueClient.createIfNotExists();
          const message = JSON.stringify({ jobId, consultantId, batchSize, dryRun });
          // Azure Storage Queue requires base64 by default
          await queueClient.sendMessage(Buffer.from(message).toString('base64'));
          log(`[runLeadSelector] async job queued jobId=${jobId} consultantId=${consultantId}`);
          return {
            status: 202,
            jsonBody: {
              accepted: true,
              jobId,
              consultantId,
              batchSize,
              dryRun,
              statusEndpoint: `/api/leadSelectorJobs?jobId=${jobId}`,
            },
          };
        } catch (err) {
          log.error(`[runLeadSelector] queue post failed: ${err.message}`, err);
          return { status: 500, jsonBody: { error: 'queue_post_failed', detail: err.message } };
        }
      }

      const consultantPayload = await rebuildConsultantFromMem0(consultantId, context);
      if (!consultantPayload) {
        return {
          status: 404,
          jsonBody: { error: 'consultant_not_found_in_mem0' },
        };
      }

      const result = await enrichAndProfileBatchForConsultant({
        brief: consultantPayload.originalBrief,
        beneficiaryId: consultantPayload.beneficiaryId,
        batchSize,
        dryRun: Boolean(dryRun),
        consultantId,
        context,
      });

      if (dryRun || result.status === 'error' || result.status === 'empty') {
        return { status: 200, jsonBody: { enrichment: result } };
      }

      // Si insuffisant : mail "base à affiner" envoyé au consultant (point
      // Paul #1 Jalon 3). Best effort — ne bloque pas la séquence partielle.
      if (result.status === 'insufficient') {
        await sendMail({
          from: process.env.DAVID_EMAIL,
          to: consultantPayload.consultant.email,
          subject: 'Lead Selector — base à affiner',
          html: buildInsufficientBatchMail(consultantPayload.originalBrief, result),
        }).catch((err) => {
          log.warn(`[enrichBatch] insufficient mail failed: ${err.message}`);
        });
      }

      // Lancement séquence sur les leads enrichis (ok + insufficient)
      const seqResults = await launchSequenceForConsultant({
        consultant: consultantPayload.consultant,
        brief: consultantPayload.brief,
        leads: result.leads,
        context,
      });

      return {
        status: 200,
        jsonBody: {
          enrichment: result,
          sequence: {
            ok_count: seqResults.filter((r) => !r.error).length,
            error_count: seqResults.filter((r) => r.error).length,
            results: seqResults,
          },
        },
      };
    } catch (err) {
      log.error('runLeadSelectorForConsultant error', err);
      return { status: 500, jsonBody: { error: err.message } };
    }
  },
});

/**
 * Reconstitue { consultant, brief, originalBrief, beneficiaryId } depuis
 * les memories Mem0 du consultant.
 *
 * `originalBrief` est le dict complet tel que soumis via le formulaire
 * (avec secteurs, effectif, zone, etc.) — consommé par `enrichBatch`.
 * `brief` est une vue réduite passée à `launchSequenceForConsultant`.
 */
async function rebuildConsultantFromMem0(consultantId, context) {
  const mem0 = getMem0(context);
  if (!mem0) return null;
  let memories;
  try {
    memories = await mem0.retrieveConsultant(consultantId);
  } catch {
    return null;
  }
  if (!memories || memories.length === 0) return null;
  const originalBrief = parseBriefFromMemories(memories);
  if (!originalBrief) return null;
  return {
    consultant: {
      nom: originalBrief.nom,
      email: originalBrief.email,
      offre: originalBrief.offre,
      ton: originalBrief.registre,
      tutoiement: originalBrief.vouvoiement === 'tu',
    },
    brief: { prospecteur: originalBrief.prospecteur || 'both' },
    originalBrief,
    beneficiaryId: `oseys-${String(consultantId || '').split('@')[0] || 'unknown'}`,
  };
}
