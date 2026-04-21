/**
 * Client Pipedrive — utilisé par David (manager commercial).
 *
 * David est le seul agent qui écrit dans Pipedrive. Martin et Mila passent
 * par lui pour logger leurs envois et leurs résultats.
 *
 * Le token n'est JAMAIS lu depuis une constante : toujours depuis l'env.
 *   process.env.PIPEDRIVE_TOKEN
 *   process.env.PIPEDRIVE_COMPANY_DOMAIN  (ex: "oseys")
 *
 * DÉPENDANCE EXTERNE CRITIQUE :
 * Les IDs d'options des enum fields (AGENT_SENDER_OPTION_ID, LAST_AGENT_
 * ATTEMPTED_OPTION_ID, stages) sont stables côté Pipedrive tant que les
 * custom fields et le pipeline ne sont pas recréés. Si tu recrées un field
 * ou un stage, les IDs changent — il faut resynchroniser ici.
 * Voir CLAUDE.md section "Dépendances externes à ne pas casser".
 *
 * Doc API : https://developers.pipedrive.com/docs/api/v1
 */

const BASE_URL = () => {
  const domain = process.env.PIPEDRIVE_COMPANY_DOMAIN;
  if (!domain) throw new Error('PIPEDRIVE_COMPANY_DOMAIN non défini');
  return `https://${domain}.pipedrive.com/api/v1`;
};

const token = () => {
  const t = process.env.PIPEDRIVE_TOKEN;
  if (!t) throw new Error('PIPEDRIVE_TOKEN non défini');
  return t;
};

/** Appel HTTP bas niveau avec gestion d'erreur uniforme */
async function call(path, { method = 'GET', body = null, query = {} } = {}) {
  const url = new URL(`${BASE_URL()}${path}`);
  url.searchParams.set('api_token', token());
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(url.toString(), opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const msg = data.error || data.error_info || `HTTP ${res.status}`;
    throw new Error(`Pipedrive ${method} ${path} → ${msg}`);
  }
  return data.data;
}

// ─── Organisations ──────────────────────────────────────────────────────────

async function searchOrganization(term) {
  const data = await call('/organizations/search', {
    query: { term, exact_match: false, limit: 10 },
  });
  return data?.items?.map((i) => i.item) || [];
}

async function getOrganization(id) {
  return call(`/organizations/${id}`);
}

async function createOrganization({ name, address, ownerId }) {
  return call('/organizations', {
    method: 'POST',
    body: { name, address, owner_id: ownerId },
  });
}

// ─── Personnes ──────────────────────────────────────────────────────────────

async function searchPerson(term) {
  const data = await call('/persons/search', {
    query: { term, exact_match: false, limit: 10 },
  });
  return data?.items?.map((i) => i.item) || [];
}

async function createPerson({ name, email, phone, orgId, ownerId }) {
  return call('/persons', {
    method: 'POST',
    body: {
      name,
      email: email ? [{ value: email, primary: true }] : [],
      phone: phone ? [{ value: phone, primary: true }] : [],
      org_id: orgId,
      owner_id: ownerId,
    },
  });
}

/** Met à jour un champ custom sur une personne (ex: email_bounced_at) */
async function updatePersonField(personId, fieldKey, value) {
  if (!personId || !fieldKey) return null;
  return call(`/persons/${personId}`, {
    method: 'PUT',
    body: { [fieldKey]: value },
  });
}

/**
 * Liste les deals d'une personne dans le pipeline Prospérenne.
 * Par défaut : uniquement les deals ouverts (comportement historique).
 * Avec { includeClosed: true } : tous les deals non supprimés (pour lecture
 * des champs de cooldown retry_available_after / opt_out_until qui sont
 * portés sur des deals déjà fermés).
 */
async function findOpenDealsForPersonInOurPipe(personId, { includeClosed = false } = {}) {
  if (!personId) return [];
  const ourPipe = Number(process.env.PIPEDRIVE_PIPELINE_ID);
  const query = { person_id: personId, limit: 100 };
  if (!includeClosed) query.status = 'open';
  const data = await call('/deals', { query });
  return Array.isArray(data) ? data.filter((d) => d.pipeline_id === ourPipe) : [];
}

/** Récupère l'email d'un utilisateur Pipedrive par son user_id (= owner d'un deal) */
async function getUserEmail(userId) {
  if (!userId) return null;
  try {
    const data = await call(`/users/${userId}`);
    return data?.email || null;
  } catch {
    return null;
  }
}

// ─── Deals ──────────────────────────────────────────────────────────────────

// IDs des options des enum fields Pipedrive (créés via API).
// Si les fields sont recréés, ces IDs changent → à resynchro via
// GET /v1/dealFields/<id>.
const AGENT_SENDER_OPTION_ID = { martin: 378, mila: 379 };
const LAST_AGENT_ATTEMPTED_OPTION_ID = { martin: 380, mila: 381 };

/**
 * Crée un deal dans le pipeline Prospérenne (par défaut stage "Nouveau lead"
 * puis bascule en "En séquence" au boot de la séquence).
 *
 * @param {Object} opts
 * @param {string} opts.title
 * @param {number} opts.personId
 * @param {number} [opts.orgId]
 * @param {number} [opts.stageId] — défaut PIPEDRIVE_STAGE_NEW
 * @param {"martin"|"mila"} [opts.agent]
 * @param {number} [opts.ownerId]
 */
async function createDeal({ title, personId, orgId, stageId, agent, ownerId }) {
  const fieldKey = process.env.PIPEDRIVE_FIELD_AGENT_SENDER;
  const custom = {};
  if (agent && fieldKey && AGENT_SENDER_OPTION_ID[agent]) {
    custom[fieldKey] = AGENT_SENDER_OPTION_ID[agent];
  }
  const finalStageId = stageId || Number(process.env.PIPEDRIVE_STAGE_NEW);
  return call('/deals', {
    method: 'POST',
    body: {
      title,
      person_id: personId,
      org_id: orgId,
      stage_id: finalStageId,
      owner_id: ownerId,
      ...custom,
    },
  });
}

async function updateDealStage(dealId, stageId) {
  return call(`/deals/${dealId}`, {
    method: 'PUT',
    body: { stage_id: stageId },
  });
}

/**
 * Recherche les deals actifs (status="open") liés à une personne OU une org,
 * dans TOUS les pipelines SAUF Prospérenne. Utilisé avant le J0 pour éviter
 * de prospecter un lead déjà travaillé par un autre consultant dans un
 * autre pipe.
 *
 * @param {Object} q
 * @param {number} [q.personId]
 * @param {number} [q.orgId]
 * @returns {Promise<Array>} deals { id, title, stage_id, pipeline_id, person_id, org_id, owner_name }
 */
async function findExistingDealsAcrossAllPipes({ personId, orgId }) {
  if (!personId && !orgId) return [];
  const ourPipe = Number(process.env.PIPEDRIVE_PIPELINE_ID);
  const results = [];
  if (personId) {
    const data = await call('/deals', { query: { person_id: personId, status: 'open', limit: 100 } });
    if (Array.isArray(data)) results.push(...data);
  }
  if (orgId) {
    const data = await call('/deals', { query: { org_id: orgId, status: 'open', limit: 100 } });
    if (Array.isArray(data)) results.push(...data);
  }
  // Dédup + filtre : on exclut les deals du pipe Prospérenne
  const seen = new Set();
  return results.filter((d) => {
    if (!d || !d.id || seen.has(d.id)) return false;
    seen.add(d.id);
    return d.pipeline_id !== ourPipe;
  });
}

/**
 * Marque un lead comme "silence fin de séquence" : stage "Fermé — silence",
 * last_agent_attempted = l'agent qui vient de faire la séquence, retry
 * dispo dans 180 jours avec l'autre agent.
 */
async function markLeadForRetry(dealId, failedAgent) {
  const body = {
    stage_id: Number(process.env.PIPEDRIVE_STAGE_CLOSED_SILENCE),
  };
  const lastAgentKey = process.env.PIPEDRIVE_FIELD_LAST_AGENT_ATTEMPTED;
  if (lastAgentKey && LAST_AGENT_ATTEMPTED_OPTION_ID[failedAgent]) {
    body[lastAgentKey] = LAST_AGENT_ATTEMPTED_OPTION_ID[failedAgent];
  }
  const retryKey = process.env.PIPEDRIVE_FIELD_RETRY_AVAILABLE_AFTER;
  if (retryKey) {
    const retryDate = new Date(Date.now() + 180 * 86_400_000);
    body[retryKey] = retryDate.toISOString().slice(0, 10);
  }
  return call(`/deals/${dealId}`, { method: 'PUT', body });
}

/**
 * Marque un lead comme opt-out permanent suite à une réponse négative du
 * prospect : stage "Fermé — refus" + opt_out_until = "9999-12-31".
 * Ce lead ne doit plus jamais être prospecté, quel que soit l'agent.
 */
async function markLeadPermanentOptOut(dealId) {
  const body = {
    stage_id: Number(process.env.PIPEDRIVE_STAGE_CLOSED_REFUSAL),
  };
  const optOutKey = process.env.PIPEDRIVE_FIELD_OPT_OUT_UNTIL;
  if (optOutKey) body[optOutKey] = '9999-12-31';
  return call(`/deals/${dealId}`, { method: 'PUT', body });
}

// ─── Activités (= logs d'envoi mail) ────────────────────────────────────────

/**
 * Log un envoi de mail (J0/J3/J7/J14) par Martin ou Mila sur un deal.
 * Crée une activité de type "email" avec subject = objet du mail
 * et note = corps résumé + identité de l'expéditeur (martin/mila).
 */
async function logEmailSent({ dealId, personId, sender, day, subject, bodyPreview }) {
  return call('/activities', {
    method: 'POST',
    body: {
      subject: `[${sender}] ${day} — ${subject}`,
      type: 'email',
      done: 1,
      deal_id: dealId,
      person_id: personId,
      note: `Envoyé par ${sender} (${sender}@oseys.fr)\nÉtape : ${day}\n\n${bodyPreview}`,
    },
  });
}

/** Log une ouverture détectée par le pixel custom */
async function logEmailOpened({ dealId, personId, sender, day }) {
  return call('/activities', {
    method: 'POST',
    body: {
      subject: `[${sender}] ${day} — mail ouvert`,
      type: 'email_open',
      done: 1,
      deal_id: dealId,
      person_id: personId,
    },
  });
}

// ─── Export ─────────────────────────────────────────────────────────────────

module.exports = {
  searchOrganization,
  getOrganization,
  createOrganization,
  searchPerson,
  createPerson,
  updatePersonField,
  createDeal,
  updateDealStage,
  findExistingDealsAcrossAllPipes,
  findOpenDealsForPersonInOurPipe,
  getUserEmail,
  markLeadForRetry,
  markLeadPermanentOptOut,
  logEmailSent,
  logEmailOpened,
};
