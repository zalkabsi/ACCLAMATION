/**
 * Deterministic, dependency-free stance clustering.
 *
 * Chat is short and repetitive, which is exactly what lexical clustering is
 * good at: the same meme, insult or "W" arrives hundreds of times with small
 * variations. We stem, drop filler, and group messages by token overlap with
 * the nearest cluster prototype. Unique chatters — not message count — is the
 * unit of consensus, so one spammer cannot invent a majority.
 *
 * The confidence number is measured here, never asserted by the model.
 */

const STOPWORDS = new Set(
  `the a an and or but if then so to of in on at for with about from as by is are was were be been being am
   i you he she it we they me my your his her its our their this that these those there here
   just really very too also still even only much many more most some any all such own same
   do does did doing done have has had having can could would should will shall may might must
   im ive id ill youre youve hes shes its were theyre weve theyve dont doesnt didnt isnt wasnt arent
   wont wouldnt couldnt shouldnt cant cannot couldve wouldve shouldve
   gonna wanna gotta kinda sorta
   lol lmao lmfao rofl haha hahaha hehe xd lul lulw omegalul kek kekw pog poggers monkas pepega pepehands sadge copium
   fr ngl tbh imo imho idk idc btw tho though well like
   what who how why when where which whats whos hows
   get got gets getting go goes going went gone make makes made say says said
   think thinks thinking know knows knew feel feels feeling want wants wanted
   new one two now out up down off over again`
    .split(/\s+/)
    .filter(Boolean),
);

const NEGATIONS = new Set(['no', 'not', 'never', 'nah', 'nope', 'aint', 'none', 'wont', 'dont']);

export function stem(token) {
  let word = token;
  if (word.length > 5 && word.endsWith('ing')) word = word.slice(0, -3);
  else if (word.length > 4 && word.endsWith('ed')) word = word.slice(0, -2);
  else if (word.length > 4 && word.endsWith('ies')) word = `${word.slice(0, -3)}y`;
  else if (word.length > 4 && word.endsWith('es')) word = word.slice(0, -2);
  else if (word.length > 4 && word.endsWith('s') && !word.endsWith('ss')) word = word.slice(0, -1);
  if (word.length > 4 && word.endsWith('e')) word = word.slice(0, -1);
  return word;
}

export function tokenize(text) {
  const cleaned = String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/['’]/g, '')
    .replace(/[@]/g, ' ')
    .replace(/[^a-z0-9\u00c0-\u024f\u0400-\u04ff\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  return cleaned
    .split(' ')
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(stem)
    .filter((t) => t.length > 1);
}

export function extractFeatures(text) {
  const features = new Map();
  for (const token of tokenize(text)) {
    features.set(token, (features.get(token) || 0) + 1);
  }
  return features;
}

export function hasNegation(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z']+/)
    .some((token) => NEGATIONS.has(token.replace(/['’]/g, '')));
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [key, weight] of a) {
    normA += weight * weight;
    const other = b.get(key);
    if (other) dot += weight * other;
  }
  for (const weight of b.values()) normB += weight * weight;
  if (!normA || !normB) return 0;
  return dot / Math.sqrt(normA * normB);
}

function cosineVector(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / Math.sqrt(normA * normB);
}

function mergeVectors(a, b, countA, countB) {
  if (!a) return b;
  if (!b) return a;
  const total = countA + countB;
  return a.map((value, index) => (value * countA + b[index] * countB) / total);
}

function validEmbeddings(vectors, expectedCount) {
  if (!Array.isArray(vectors) || vectors.length !== expectedCount || expectedCount === 0) return false;
  const dimension = vectors[0]?.length;
  if (!Number.isInteger(dimension) || dimension < 1) return false;
  return vectors.every(
    (vector) =>
      Array.isArray(vector) &&
      vector.length === dimension &&
      vector.every((value) => Number.isFinite(value)),
  );
}

function topFeatures(centroid, limit = 40) {
  return new Map([...centroid.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit));
}

function representativeScore(message, clusterTerms) {
  let score = 0;
  const text = message.text;
  if (clusterTerms[0] && text.toLowerCase().includes(clusterTerms[0])) score += 3;
  if (clusterTerms[1] && text.toLowerCase().includes(clusterTerms[1])) score += 1.5;
  if (text.length >= 12 && text.length <= 120) score += 1;
  if (text.length > 220) score -= 2;
  if (/^[\p{Extended_Pictographic}\s]+$/u.test(text)) score -= 3;
  if (/\b(?:https?:\/\/|www\.)/i.test(text)) score -= 5;
  return score;
}

function pickRepresentatives(messages, terms, limit = 3) {
  const best = new Map();
  for (const message of messages) {
    const score = representativeScore(message, terms);
    const current = best.get(message.userId);
    if (!current || score > current.score) best.set(message.userId, { message, score });
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || b.message.ts - a.message.ts)
    .slice(0, limit)
    .map(({ message }) => ({
      id: message.id,
      login: message.login,
      display: message.display,
      text: message.text,
    }));
}

function mergeCentroid(a, b) {
  const merged = new Map(a);
  for (const [feature, weight] of b) merged.set(feature, (merged.get(feature) || 0) + weight);
  return topFeatures(merged, 60);
}

function buildCluster(units) {
  const members = units
    .map((unit) => unit.message)
    .sort((a, b) => a.ts - b.ts || (a.index ?? 0) - (b.index ?? 0));
  const userIds = [...new Set(members.map((m) => m.userId))];
  const freq = new Map();
  for (const unit of units) {
    for (const [feature, count] of unit.features) {
      freq.set(feature, (freq.get(feature) || 0) + count);
    }
  }
  const terms = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([feature]) => feature);

  return {
    kind: 'words',
    messages: members,
    userIds,
    userCount: userIds.length,
    messageCount: members.length,
    centroid: topFeatures(freq, 60),
    terms,
    topTerms: terms.slice(0, 4),
    representatives: [],
    firstAt: members.length ? members[0].ts : 0,
  };
}

/** Cluster messages by embeddings when supplied, otherwise use lexical features.
 * The embed callback receives the usable message texts in input order and may
 * return their vectors directly or as a promise. Failed/invalid embeddings
 * fall back to the deterministic lexical implementation.
 *
 * @param {Array<{id:string,userId:string,login:string,text:string,ts:number,index?:number}>} messages
 * @param {{threshold?:number, mergeThreshold?:number, maxClusters?:number, embed?:(texts:string[])=>number[][]|Promise<number[][]>, onEmbedError?:(error:Error)=>void}} options
 */
export function clusterMessages(messages, options = {}) {
  if (typeof options.embed !== 'function') return clusterPrepared(messages, options);

  const usableTexts = messages
    .filter((message) => extractFeatures(message.text).size > 0)
    .map((message) => message.text);
  if (usableTexts.length === 0) return clusterPrepared(messages, options);

  const fallback = (error) => {
    if (error) options.onEmbedError?.(error);
    return clusterPrepared(messages, options);
  };
  try {
    const result = options.embed(usableTexts);
    if (result && typeof result.then === 'function') {
      return result.then((vectors) =>
        validEmbeddings(vectors, usableTexts.length)
          ? clusterPrepared(messages, options, vectors)
          : fallback(new Error('embedding provider returned invalid vectors')),
      ).catch(fallback);
    }
    return validEmbeddings(result, usableTexts.length)
      ? clusterPrepared(messages, options, result)
      : fallback(new Error('embedding provider returned invalid vectors'));
  } catch (error) {
    return fallback(error);
  }
}

function clusterPrepared(messages, options, embeddings = null) {
  const threshold = options.threshold ?? (embeddings ? 0.78 : 0.4);
  const mergeThreshold = options.mergeThreshold ?? (embeddings ? 0.88 : 0.62);
  const maxClusters = options.maxClusters ?? 8;

  const usable = [];
  const reactions = [];
  let embeddingIndex = 0;
  for (const message of messages) {
    const features = extractFeatures(message.text);
    if (features.size === 0) reactions.push(message);
    else {
      usable.push({
        message,
        features,
        negated: hasNegation(message.text),
        vector: embeddings?.[embeddingIndex] ?? null,
      });
      embeddingIndex += 1;
    }
  }

  const similarityBetween = (a, b) => {
    let similarity = embeddings ? cosineVector(a.vector, b.vector) : cosine(a.features, b.features);
    if (a.negated !== b.negated) similarity *= 0.55;
    return similarity;
  };

  // Each cluster keeps a handful of prototypes. Comparing against any of them
  // (rather than a growing centroid) stops similarity from being diluted as a
  // cluster fills up, which is what over-splits short chat.
  let clusters = [];
  const ordered = usable.sort(
    (a, b) => a.message.ts - b.message.ts || (a.message.index ?? 0) - (b.message.index ?? 0),
  );
  for (const unit of ordered) {
    let best = null;
    let bestSimilarity = 0;
    for (const cluster of clusters) {
      let similarity = 0;
      for (const prototype of cluster.prototypes) {
        const s = similarityBetween(unit, prototype);
        if (s > similarity) similarity = s;
      }
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        best = cluster;
      }
    }
    if (best && bestSimilarity >= threshold) {
      const previousCount = best.units.length;
      best.units.push(unit);
      if (best.prototypes.length < 8) best.prototypes.push(unit);
      best.centroid = mergeCentroid(best.centroid, unit.features);
      if (embeddings) best.vectorCentroid = mergeVectors(best.vectorCentroid, unit.vector, previousCount, 1);
    } else {
      clusters.push({
        units: [unit],
        prototypes: [unit],
        centroid: topFeatures(unit.features, 60),
        vectorCentroid: unit.vector,
      });
    }
  }

  // Merge near-duplicate clusters (greedy, deterministic).
  for (let pass = 0; pass < 12; pass += 1) {
    let bestPair = null;
    let bestSimilarity = 0;
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const similarity = embeddings
          ? cosineVector(clusters[i].vectorCentroid, clusters[j].vectorCentroid)
          : cosine(clusters[i].centroid, clusters[j].centroid);
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestPair = [i, j];
        }
      }
    }
    if (!bestPair || bestSimilarity < mergeThreshold) break;
    const [i, j] = bestPair;
    const countI = clusters[i].units.length;
    const countJ = clusters[j].units.length;
    clusters[i].units.push(...clusters[j].units);
    clusters[i].prototypes.push(...clusters[j].prototypes.slice(0, 8 - clusters[i].prototypes.length));
    clusters[i].centroid = mergeCentroid(clusters[i].centroid, clusters[j].centroid);
    if (embeddings) {
      clusters[i].vectorCentroid = mergeVectors(clusters[i].vectorCentroid, clusters[j].vectorCentroid, countI, countJ);
    }
    clusters.splice(j, 1);
  }

  // Keep the picture readable: fold the smallest clusters into their nearest
  // neighbour until at most `maxClusters` remain.
  while (clusters.length > maxClusters) {
    clusters.sort((a, b) => a.units.length - b.units.length);
    const [smallest] = clusters;
    let target = clusters[1];
    let bestSimilarity = -1;
    for (const candidate of clusters.slice(1)) {
      const similarity = embeddings
        ? cosineVector(smallest.vectorCentroid, candidate.vectorCentroid)
        : cosine(smallest.centroid, candidate.centroid);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        target = candidate;
      }
    }
    const targetCount = target.units.length;
    target.units.push(...smallest.units);
    target.centroid = mergeCentroid(target.centroid, smallest.centroid);
    if (embeddings) {
      target.vectorCentroid = mergeVectors(
        target.vectorCentroid,
        smallest.vectorCentroid,
        targetCount,
        smallest.units.length,
      );
    }
    clusters = clusters.filter((c) => c !== smallest);
  }

  clusters = clusters.map((cluster) => buildCluster(cluster.units));

  const totalChatters = new Set([
    ...usable.map((unit) => unit.message.userId),
    ...reactions.map((message) => message.userId),
  ]).size;

  for (const cluster of clusters) {
    cluster.representatives = pickRepresentatives(cluster.messages, cluster.terms, 3);
  }

  if (reactions.length) {
    const userIds = [...new Set(reactions.map((m) => m.userId))];
    clusters.push({
      kind: 'reaction',
      messages: reactions,
      userIds,
      userCount: userIds.length,
      messageCount: reactions.length,
      centroid: new Map(),
      terms: [],
      topTerms: [],
      representatives: pickRepresentatives(reactions, [], 2),
      firstAt: Math.min(...reactions.map((m) => m.ts)),
    });
  }

  clusters.sort((a, b) => b.userCount - a.userCount || a.firstAt - b.firstAt);
  clusters.forEach((cluster, index) => {
    cluster.id = `c${index + 1}`;
    cluster.label =
      cluster.kind === 'reaction' ? 'just emotes' : cluster.terms.slice(0, 2).join(' ') || 'misc';
    cluster.share = totalChatters ? cluster.userCount / totalChatters : 0;
  });

  return { clusters, totalChatters, totalMessages: messages.length, reactions: reactions.length };
}

/**
 * Turn cluster counts into a mode + a measured confidence.
 *
 * `confidence` estimates how sure we are that the leading stance really is
 * chat's stance, given the sample size (shrinkage toward 50% when few people
 * spoke). It is computed here and attached to answers; the model never sets it.
 */
export function measureConsensus(clusters, { minChatters = 4, totalChatters } = {}) {
  const chatters = totalChatters ?? new Set(clusters.flatMap((c) => c.userIds)).size;
  const words = clusters.filter((c) => c.kind === 'words');
  const top = words[0] || null;
  const second = words[1] || null;
  const reactionCluster = clusters.find((c) => c.kind === 'reaction');
  const topShare = top ? top.userCount / Math.max(1, chatters) : 0;
  const secondShare = second ? second.userCount / Math.max(1, chatters) : 0;
  const reactionShare = reactionCluster ? reactionCluster.userCount / Math.max(1, chatters) : 0;
  const reliability = 1 - Math.exp(-chatters / 12);

  const base = {
    totalChatters: chatters,
    topClusterId: top?.id ?? null,
    secondClusterId: second?.id ?? null,
    topShare: round3(topShare),
    secondShare: round3(secondShare),
    reactionShare: round3(reactionShare),
    reliability: round3(reliability),
  };

  if (!top || chatters < minChatters) {
    return {
      ...base,
      mode: 'insufficient',
      confidence: null,
      reason: !top ? 'no_words' : 'sample_too_small',
      split: null,
    };
  }

  if (reactionShare > 0.5) {
    return { ...base, mode: 'unclear', confidence: null, reason: 'emote_wall', split: null };
  }

  const margin = topShare - secondShare;
  const dissent =
    secondShare >= 0.25 &&
    topShare < 0.62 &&
    secondShare > 0 &&
    top.userCount / second.userCount <= 2.8;

  if (dissent) {
    const confidence = clamp(
      Math.round((topShare + secondShare) * 100 * (0.86 + 0.14 * reliability)),
      20,
      96,
    );
    return {
      ...base,
      mode: 'dissent',
      confidence,
      reason: 'two_sides',
      split: { a: Math.round(topShare * 100), b: Math.round(secondShare * 100) },
    };
  }

  if (topShare < 0.4) {
    return { ...base, mode: 'unclear', confidence: null, reason: 'scattered', split: null };
  }

  const confidence = clamp(
    Math.round(50 + (topShare * 100 - 50) * reliability + Math.max(0, margin) * 15 * reliability),
    8,
    96,
  );

  return { ...base, mode: 'consensus', confidence, reason: 'one_side', split: null };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
