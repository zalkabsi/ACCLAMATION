import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { clusterMessages, measureConsensus } from '../chat/cluster.js';
import { buildMessages, buildPromptPayload, allowedMessageIds } from '../llm/prompt.js';
import { ContractError, parseModelJson, validateAnswer } from '../llm/contract.js';
import { complete, ProviderError } from '../llm/provider.js';
import { composeLocalAnswer, composeRefusal } from '../llm/local.js';

export class BusyError extends Error {
  constructor() {
    super('an answer is already being generated');
    this.name = 'BusyError';
  }
}

/**
 * One channel, one voice.
 *
 * Owns the rolling window, turns a snapshot into clusters, asks the model for
 * an *answer that cites message ids*, validates it against the measured truth,
 * falls back to the local voice if the model fails, and records the call.
 * Nothing leaves this class without passing validation.
 */
export class ChannelSession extends EventEmitter {
  constructor({
    config,
    memory,
    window,
    logger,
    now = () => Date.now(),
    completeFn = complete,
  }) {
    super();
    this.config = config;
    this.memory = memory;
    this.window = window;
    this.logger = logger;
    this.now = now;
    this.completeFn = completeFn;
    this._pending = false;
    this.recent = [];
    this._lastMeasurement = null;
  }

  /** Route an EventSub notification into the window. */
  ingest(subscriptionType, event, metadata = {}) {
    switch (subscriptionType) {
      case 'channel.chat.message':
        return this._onChat(event, metadata);
      case 'channel.chat.message_delete':
        return this._onDelete(event);
      case 'channel.raid':
        return this._onRaid(event);
      case 'channel.subscribe':
        return this._onSubscribe(event);
      default:
        return { accepted: false, reason: 'unhandled_type' };
    }
  }

  _onChat(event, metadata) {
    const timestamp = Date.parse(metadata.message_timestamp ?? '');
    const result = this.window.add({
      id: event.message_id,
      userId: event.chatter_user_id,
      login: event.chatter_user_login,
      display: event.chatter_user_name,
      text: event.message?.text ?? '',
      messageType: event.message_type,
      badges: event.badges,
      color: event.color,
      isReply: Boolean(event.reply),
      ts: Number.isFinite(timestamp) ? timestamp : this.now(),
    });
    if (result.added) {
      this.emit('chat', {
        id: result.message.id,
        user: result.message.display,
        text: result.message.text,
        at: this.now(),
      });
    }
    return result;
  }

  _onDelete(event) {
    const removed = this.window.delete(event.message_id);
    this.emit('delete', { messageId: event.message_id, user: event.target_user_login, removed });
    return { removed };
  }

  _onRaid(event) {
    const raid = {
      kind: 'raid',
      from: event.from_broadcaster_user_name || event.from_broadcaster_user_login,
      viewers: Number(event.viewers) || 0,
      at: this.now(),
    };
    this.emit('hype', raid);
    return { accepted: true };
  }

  _onSubscribe(event) {
    const hype = {
      kind: 'subscribe',
      from: event.user_name || event.user_login,
      tier: event.tier,
      gifted: Boolean(event.is_gift),
      at: this.now(),
    };
    this.emit('hype', hype);
    return { accepted: true };
  }

  _measure(snapshot) {
    const { clusters, totalChatters } = clusterMessages(snapshot.messages);
    const measurement = measureConsensus(clusters, {
      minChatters: this.config.channel.minChatters,
      totalChatters,
    });
    return { clusters, measurement };
  }

  async ask({ question, forceMode } = {}) {
    if (this._pending) throw new BusyError();
    this._pending = true;
    const startedAt = performance.now();
    const askedAt = this.now();
    const text = String(question || this.config.defaultQuestion)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);

    try {
      const snapshot = this.window.snapshot();
      const { clusters, measurement } = this._measure(snapshot);
      if (forceMode === 'dissent' && measurement.mode === 'consensus' && clusters.length >= 2) {
        // The streamer can force the argument even on a lopsided window; the
        // shares still come from the measurements, never from the override.
        measurement.mode = 'dissent';
        measurement.split = {
          a: Math.round(measurement.topShare * 100),
          b: Math.round(measurement.secondShare * 100),
        };
      }
      this._lastMeasurement = measurement;

      this.emit('trigger:start', {
        question: text,
        mode: measurement.mode,
        chatters: measurement.totalChatters,
        at: askedAt,
      });

      const allowed = allowedMessageIds(clusters);

      if (measurement.mode === 'insufficient' || measurement.mode === 'unclear') {
        return this._refuse({ clusters, measurement, snapshot, question: text, askedAt, startedAt });
      }

      const lore = this.memory.listLore(4);
      const payload = buildPromptPayload({
        question: text,
        measurement,
        clusters,
        stats: snapshot.stats,
        lore,
        windowSeconds: this.config.channel.windowSeconds,
      });

      let answer = null;
      let provider = 'local';
      let modelMs = 0;
      let attempts = 0;
      const warnings = [];

      if (this.config.provider !== 'local') {
        try {
          const result = await this._askModel(payload, measurement.mode, allowed);
          answer = result.value;
          provider = 'openai';
          modelMs = result.modelMs;
          attempts = result.attempts;
          warnings.push(...result.warnings);
        } catch (error) {
          const message = error instanceof ContractError ? error.errors.join('; ') : error.message;
          this.logger?.warn('model answer rejected, using local voice', { error: message });
          this.emit('provider:error', { message, at: this.now() });
        }
      }

      if (!answer) {
        const local = composeLocalAnswer({ measurement, clusters });
        const validation = validateAnswer(local, { mode: measurement.mode, allowed });
        if (!validation.ok) {
          this.logger?.error('local answer failed validation', { errors: validation.errors });
          return this._refuse({
            clusters,
            measurement: { ...measurement, mode: 'unclear', reason: 'scattered', confidence: null },
            snapshot,
            question: text,
            askedAt,
            startedAt,
          });
        }
        answer = validation.value;
        provider = 'local';
      }

      const receipts = flattenReceipts(answer);
      const totalMs = Math.round(performance.now() - startedAt);
      const final = {
        id: randomUUID(),
        at: new Date(askedAt).toISOString(),
        question: text,
        mode: answer.mode,
        stance: answer.stance ?? null,
        voices: answer.voices ?? null,
        note: answer.note ?? null,
        receipts,
        confidence: measurement.confidence,
        split: measurement.split,
        share: measurement.topShare,
        chatters: measurement.totalChatters,
        basis: {
          chatters: measurement.totalChatters,
          messages: snapshot.stats.activeMessages,
          filtered: snapshot.stats.filteredByReason,
          topShare: measurement.topShare,
          secondShare: measurement.secondShare,
          reliability: measurement.reliability,
        },
        provider,
        model: provider === 'local' ? 'local' : this.config.llm.model,
        timings: { modelMs, totalMs, attempts },
        warnings,
      };

      this.memory.recordCall({
        question: text,
        mode: final.mode,
        stance: final.stance ?? final.voices?.map((v) => `${v.label}: ${v.stance}`).join(' | '),
        confidence: final.confidence,
        provider,
        receipts,
        at: final.at,
      });
      this._remember(final);
      this.emit('answer', final);
      return final;
    } finally {
      this._pending = false;
    }
  }

  async _askModel(payload, mode, allowed) {
    const messages = buildMessages(payload);
    let modelMs = 0;
    let attempts = 0;

    const first = await this.completeFn({ messages, llm: this.config.llm });
    attempts += 1;
    modelMs += first.latencyMs;
    try {
      const parsed = parseModelJson(first.text);
      const validation = validateAnswer(parsed, { mode, allowed });
      if (validation.ok) return { value: validation.value, modelMs, attempts, warnings: validation.warnings };
      throw new ContractError('model answer failed validation', validation.errors);
    } catch (error) {
      if (!(error instanceof ContractError)) throw error;
      // One repair attempt with the validator's own complaints attached.
      const repair = await this.completeFn({
        messages: [
          ...messages,
          { role: 'assistant', content: first.text.slice(0, 1200) },
          {
            role: 'user',
            content: `That answer failed validation: ${error.errors.join('; ')}. Return the corrected JSON object only. Cite only message_id values from the supplied samples.`,
          },
        ],
        llm: this.config.llm,
      });
      attempts += 1;
      modelMs += repair.latencyMs;
      const parsed = parseModelJson(repair.text);
      const validation = validateAnswer(parsed, { mode, allowed });
      if (!validation.ok) throw new ContractError('model answer failed validation twice', validation.errors);
      return { value: validation.value, modelMs, attempts, warnings: validation.warnings };
    }
  }

  _refuse({ clusters, measurement, snapshot, question, askedAt, startedAt }) {
    const refusal = composeRefusal({
      measurement,
      clusters,
      reason: measurement.reason ?? (measurement.totalChatters === 0 ? 'no_words' : 'scattered'),
    });
    const allowed = new Map();
    for (const cluster of clusters) {
      for (const message of cluster.messages) allowed.set(message.id, { ...message, clusterId: cluster.id });
    }
    const receipts = refusal.receipts
      .map((id) => allowed.get(id))
      .filter(Boolean)
      .map((message) => ({
        message_id: message.id,
        user: message.display,
        text: message.text,
        cluster_id: message.clusterId,
      }));

    const final = {
      id: randomUUID(),
      at: new Date(askedAt).toISOString(),
      question,
      mode: refusal.mode,
      stance: refusal.stance,
      voices: null,
      note: null,
      receipts,
      confidence: null,
      split: measurement.split,
      share: measurement.topShare ?? 0,
      chatters: measurement.totalChatters,
      basis: {
        chatters: measurement.totalChatters,
        messages: snapshot.stats.activeMessages,
        filtered: snapshot.stats.filteredByReason,
        topShare: measurement.topShare,
        secondShare: measurement.secondShare,
        reliability: measurement.reliability,
      },
      provider: 'local',
      model: 'local',
      reason: measurement.reason ?? null,
      timings: { modelMs: 0, totalMs: Math.round(performance.now() - startedAt), attempts: 0 },
      warnings: [],
    };
    this.memory.recordCall({
      question,
      mode: final.mode,
      stance: final.stance,
      confidence: null,
      provider: 'local',
      receipts,
      at: final.at,
    });
    this._remember(final);
    this.emit('answer', final);
    return final;
  }

  _remember(answer) {
    this.recent.unshift(answer);
    this.recent = this.recent.slice(0, 8);
  }

  state() {
    return {
      stats: this.window.stats(),
      lastAnswer: this.recent[0] ?? null,
      recent: this.recent.slice(0, 5),
      measurement: this._lastMeasurement,
      scoreboard: this.memory.getScoreboard(),
      lore: this.memory.listLore(6),
    };
  }

  markScore(winner) {
    if (!['chat', 'streamer'].includes(winner)) throw new Error('winner must be chat or streamer');
    const board = this.memory.score(winner);
    this.emit('score', { ...board, at: this.now() });
    return board;
  }
}

function flattenReceipts(answer) {
  if (answer.mode === 'dissent' && Array.isArray(answer.voices)) {
    const seen = new Set();
    const receipts = [];
    for (const voice of answer.voices) {
      for (const receipt of voice.receipts) {
        if (seen.has(receipt.message_id)) continue;
        seen.add(receipt.message_id);
        receipts.push({ ...receipt, voice: voice.label });
      }
    }
    return receipts;
  }
  return answer.receipts ?? [];
}
