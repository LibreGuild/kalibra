/*
 * Ids in the W3C Trace Context format, so traces line up with OpenTelemetry and with the
 * `traceparent` header Kalibra sends to your app during eval runs.
 */

import { randomBytes } from 'node:crypto';

/** 32 lowercase hex characters (16 random bytes). */
export const newTraceId = () => randomBytes(16).toString('hex');

/** 16 lowercase hex characters (8 random bytes). */
export const newSpanId = () => randomBytes(8).toString('hex');

export const nowIso = () => new Date().toISOString();
