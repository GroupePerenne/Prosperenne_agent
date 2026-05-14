'use strict';

/**
 * Schémas et constantes du chantier lead-exhauster.
 *
 * - Noms de tables Azure Storage (configurables via env)
 * - Typedefs JSDoc de l'interface publique leadExhauster(input) → output
 * - Types des sources, du status, des signaux de traçabilité
 *
 * Les schémas des tables sont documentés inline pour servir de source de
 * vérité lors de la création des tables côté Azure (pas de migration ORM
 * en V1, les tables sont créées à la volée par les writers qui en ont besoin).
 */

// ─── Noms de tables ────────────────────────────────────────────────────────

const TABLE_LEAD_CONTACTS = process.env.LEADCONTACTS_TABLE || 'LeadContacts';
const TABLE_EMAIL_PATTERNS = process.env.EMAIL_PATTERNS_TABLE || 'EmailPatterns';
const TABLE_EMAIL_BLACKLISTED_PATTERNS =
  process.env.EMAIL_BLACKLISTED_PATTERNS_TABLE || 'EmailBlacklistedPatterns';
const TABLE_EMAIL_UNRESOLVABLE = process.env.EMAIL_UNRESOLVABLE_TABLE || 'EmailUnresolvable';
const TABLE_BUDGETS = process.env.BUDGETS_TABLE || 'Budgets';
const TABLE_EXPERIMENTS = process.env.EXPERIMENTS_TABLE || 'Experiments';

// ─── Seuils et constantes produit ──────────────────────────────────────────

const DEFAULT_CONFIDENCE_THRESHOLD = Number(
  process.env.LEAD_EXHAUSTER_CONFIDENCE_THRESHOLD || 0.7,
);

const SOURCES = Object.freeze({
  INTERNAL_PATTERNS: 'internal_patterns',
  INTERNAL_SCRAPING: 'internal_scraping',
  GOOGLE_SITE: 'google_site',
  LINKEDIN_SIGNAL: 'linkedin_signal',
  DROPCONTACT: 'dropcontact',
  CACHE: 'cache',
});

const STATUS = Object.freeze({
  OK: 'ok',
  UNRESOLVABLE: 'unresolvable',
  ERROR: 'error',
});

const DECISION_MAKER_SOURCES = Object.freeze({
  INSEE: 'insee',
  WEBSITE: 'website',
  LINKEDIN_ENTREPRISE: 'linkedin_entreprise',
  GOOGLE: 'google',
});

const DOMAIN_SOURCES = Object.freeze({
  LEADBASE: 'leadbase',
  API_GOUV: 'api_gouv',
  GOOGLE: 'google',
  SCRAPING: 'scraping',
  INPUT: 'input',
});

// ─── Typedefs (JSDoc) ──────────────────────────────────────────────────────

/**
 * @typedef {Object} LeadExhausterInput
 * @property {string}  siren                  SIREN 9 chiffres (obligatoire).
 * @property {string}  beneficiaryId          Scoping cache/billing/audit.
 * @property {string}  [firstName]            Prénom décideur (optionnel).
 * @property {string}  [lastName]             Nom décideur (optionnel).
 * @property {string}  [companyName]          Raison sociale.
 * @property {string}  [companyDomain]        Domaine connu (skip resolveDomain).
 * @property {string}  [companyLinkedInUrl]   URL LinkedIn entreprise connue.
 * @property {number}  [confidenceThreshold]  Seuil custom (défaut 0.70).
 * @property {Object}  [experimentsContext]   Voir SPEC_AB_TESTING §4.
 * @property {boolean} [simulated]            Mode dryRun : skip Dropcontact.
 */

/**
 * @typedef {Object} ResolvedDecisionMaker
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} role
 * @property {'insee'|'website'|'linkedin_entreprise'|'google'} source
 * @property {number} confidence
 */

/**
 * @typedef {Object} LeadExhausterOutput
 * @property {'ok'|'unresolvable'|'error'} status
 * @property {string|null}            email
 * @property {number}                 confidence               0-1
 * @property {'internal_patterns'|'internal_scraping'|'google_site'|'linkedin_signal'|'dropcontact'|'cache'} source
 * @property {string[]}               signals                  Traçabilité.
 * @property {number}                 cost_cents               0 si internal.
 * @property {ResolvedDecisionMaker|null} resolvedDecisionMaker
 * @property {string|null}            resolvedDomain           Normalisé.
 * @property {boolean}                cached                   True si cache hit.
 * @property {number}                 elapsedMs
 * @property {string[]}               experimentsApplied       Tags A/B.
 * @property {boolean}                [simulated]              True en dryRun.
 */

/**
 * Schéma table Azure `LeadContacts` — source de vérité des résolutions.
 *
 *   PartitionKey : siren (9 chiffres)
 *   RowKey       : `email_{normFirstName}_{normLastName}` (lowercase, accents
 *                  strippés, non-alpha → underscore). Si firstName/lastName
 *                  vides (résolution contact@ catch-all), RowKey = `email__`.
 *
 *   Colonnes :
 *     siren, email, confidence (number), source,
 *     signals (string JSON),        cost_cents (number),
 *     firstName, lastName, role, roleSource, roleConfidence (number),
 *     domain, domainSource,
 *     naf (ex. "70.22Z"), tranche (code INSEE effectif),
 *     resolvedAt (ISO), lastVerifiedAt (ISO),
 *     feedbackStatus (null|'delivered'|'bounced'|'replied'|'spam_flagged'),
 *     feedbackAt (ISO),
 *     experimentsApplied (string JSON),
 *     beneficiaryId
 *
 *   Les champs `naf` et `tranche` sont dupliqués depuis LeadBase/candidate
 *   pour permettre à `patternsLearner` (Jalon 4) d'agréger par
 *   (nafDivision, tranche, patternId) sans re-lookup LeadBase ligne par ligne.
 *
 *   TTL logique : 90 jours après lastVerifiedAt. Au-delà, re-résolution.
 *   Purge RGPD : endpoint admin qui scan PartitionKey=siren et delete.
 *
 * @typedef {Object} LeadContactRow
 * @property {string} siren
 * @property {string|null} email
 * @property {number} confidence
 * @property {string} source
 * @property {string} signals           JSON stringifié
 * @property {number} cost_cents
 * @property {string} firstName         lowercase normalisé
 * @property {string} lastName          lowercase normalisé
 * @property {string} [role]
 * @property {string} [roleSource]
 * @property {number} [roleConfidence]
 * @property {string|null} domain
 * @property {string} [domainSource]
 * @property {string} [naf]             Code NAF complet (ex. "70.22Z")
 * @property {string} [tranche]         Code tranche effectif INSEE (ex. "11")
 * @property {string} resolvedAt        ISO
 * @property {string} lastVerifiedAt    ISO
 * @property {string|null} [feedbackStatus]
 * @property {string|null} [feedbackAt] ISO
 * @property {string} [experimentsApplied] JSON stringifié
 * @property {string} beneficiaryId
 */

/**
 * Schéma table `EmailPatterns` — patterns email self-learning.
 *
 *   PartitionKey : nafDivision (2 premiers chiffres NAF, ex. "70")
 *   RowKey       : `{trancheEffectif}_{patternId}` (ex. "11_first.last")
 *
 *   Colonnes :
 *     pattern (ex. "{first}.{last}@{domain}"),
 *     naf, tranche,
 *     sampleSize (nb tests), successRate (0-1), bounceRate (0-1),
 *     active (bool), lastUpdatedAt (ISO)
 *
 *   Un pattern avec bounceRate > 0.30 sur sampleSize > 20 est désactivé
 *   (soft : active=false, historique préservé).
 *
 * @typedef {Object} EmailPatternRow
 * @property {string} pattern
 * @property {string} naf
 * @property {string} tranche
 * @property {number} sampleSize
 * @property {number} successRate
 * @property {number} bounceRate
 * @property {boolean} active
 * @property {string} lastUpdatedAt
 */

/**
 * Schéma table `EmailUnresolvable` — prospects non résolus.
 *
 *   PartitionKey : beneficiaryId
 *   RowKey       : `{reverseTimestamp}_{siren}` — antichronologique naturel
 *
 *   Colonnes :
 *     siren, reason, signalsExhausted (JSON), lastAttemptedAt (ISO),
 *     firstName, lastName, companyName
 *
 *   Consommée par Charli (review manuelle) ou retry différé.
 *
 * @typedef {Object} EmailUnresolvableRow
 * @property {string} siren
 * @property {string} reason
 * @property {string} signalsExhausted  JSON stringifié
 * @property {string} lastAttemptedAt   ISO
 * @property {string} firstName
 * @property {string} lastName
 * @property {string} companyName
 */

/**
 * @typedef {Object} EnrichBatchResult
 * @property {'ok'|'insufficient'|'empty'|'error'} status
 * @property {Array<Object>} leads             Leads enrichis prêts pour runSequence
 * @property {number} unresolvableCount        Prospects filés en EmailUnresolvable
 * @property {Object} selectorMeta             Meta retournée par selectCandidatesForConsultant
 * @property {Object} meta                     Meta enrichissement
 * @property {number} meta.requested
 * @property {number} meta.returned
 * @property {number} meta.candidatesConsidered
 * @property {number} meta.resolutionAttempts
 * @property {number} meta.resolutionOk
 * @property {number} meta.resolutionUnresolvable
 * @property {number} meta.costCentsTotal
 * @property {boolean} meta.dryRun
 * @property {number} meta.elapsedMs
 * @property {string} [meta.reason]
 */

/**
 * Schéma table `Budgets` — compteurs mensuels pour plafonnement Dropcontact
 * (et futurs providers payants).
 *
 *   PartitionKey : provider (ex. "dropcontact")
 *   RowKey       : monthKey YYYYMM (ex. "202605")
 *
 *   Colonnes :
 *     spent_cents (number), budget_cents (number),
 *     calls (number), lastUpdatedAt (ISO)
 *
 * @typedef {Object} BudgetRow
 * @property {string} provider
 * @property {string} monthKey
 * @property {number} spent_cents
 * @property {number} budget_cents
 * @property {number} calls
 * @property {string} lastUpdatedAt
 */

module.exports = {
  // Tables
  TABLE_LEAD_CONTACTS,
  TABLE_EMAIL_PATTERNS,
  TABLE_EMAIL_BLACKLISTED_PATTERNS,
  TABLE_EMAIL_UNRESOLVABLE,
  TABLE_BUDGETS,
  TABLE_EXPERIMENTS,
  // Constantes produit
  DEFAULT_CONFIDENCE_THRESHOLD,
  SOURCES,
  STATUS,
  DECISION_MAKER_SOURCES,
  DOMAIN_SOURCES,
};
