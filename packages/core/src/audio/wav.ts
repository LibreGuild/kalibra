/*
 * Minimal WAV (RIFF) reader/writer. Supports PCM 8/16/24/32-bit integer, 32/64-bit float and
 * WAVE_FORMAT_EXTENSIBLE. Other containers (mp3, ogg, flac, m4a, webm) go through ffmpeg in convert.ts.
 */

export interface DecodedAudio {
  sampleRate: number;
  /** One Float32Array per channel, samples in [-1, 1]. */
  channels: Float32Array[];
}

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

export function isWav(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 12) return false;
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  return tag(0) === 'RIFF' && tag(8) === 'WAVE';
}

export function decodeWav(bytes: Uint8Array): DecodedAudio {
  if (!isWav(bytes)) throw new Error('Not a WAV file (missing RIFF/WAVE header)');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  let format = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + 8 <= bytes.byteLength) {
    const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === FORMAT_EXTENSIBLE && size >= 40) {
        // The sub-format GUID starts with the actual format code.
        format = view.getUint16(body + 24, true);
      }
    } else if (id === 'data') {
      dataStart = body;
      // Some streaming writers put 0 or 0xFFFFFFFF here; clamp to what is actually present.
      dataLength = size === 0 || body + size > bytes.byteLength ? bytes.byteLength - body : size;
      break;
    }
    offset = body + size + (size % 2);
  }

  if (!sampleRate || !channelCount) throw new Error('WAV file has no fmt chunk');
  if (dataStart < 0) throw new Error('WAV file has no data chunk');
  if (format !== FORMAT_PCM && format !== FORMAT_FLOAT) {
    throw new Error(`Unsupported WAV encoding (format code ${format}); convert to PCM or install ffmpeg`);
  }

  const bytesPerSample = bits / 8;
  const frameSize = bytesPerSample * channelCount;
  const frames = Math.floor(dataLength / frameSize);
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const p = dataStart + i * frameSize + c * bytesPerSample;
      let v: number;
      if (format === FORMAT_FLOAT) {
        v = bits === 64 ? view.getFloat64(p, true) : view.getFloat32(p, true);
      } else if (bits === 8) {
        v = (view.getUint8(p) - 128) / 128;
      } else if (bits === 16) {
        v = view.getInt16(p, true) / 32768;
      } else if (bits === 24) {
        const raw = view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getInt8(p + 2) << 16);
        v = raw / 8388608;
      } else if (bits === 32) {
        v = view.getInt32(p, true) / 2147483648;
      } else {
        throw new Error(`Unsupported WAV bit depth: ${bits}`);
      }
      channels[c][i] = v;
    }
  }
  return { sampleRate, channels };
}

/** Averages all channels into one. */
export function toMono(audio: DecodedAudio): Float32Array {
  if (audio.channels.length === 1) return audio.channels[0];
  const n = audio.channels[0].length;
  const out = new Float32Array(n);
  for (const ch of audio.channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  for (let i = 0; i < n; i++) out[i] /= audio.channels.length;
  return out;
}

/** Writes 16-bit PCM WAV. Interleaves when several channels are given. */
export function encodeWav(channels: Float32Array[], sampleRate: number): Buffer {
  const channelCount = channels.length;
  const frames = channels[0]?.length ?? 0;
  const dataLength = frames * channelCount * 2;
  const buf = Buffer.alloc(44 + dataLength);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + dataLength, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(FORMAT_PCM, 20);
  buf.writeUInt16LE(channelCount, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channelCount * 2, 28);
  buf.writeUInt16LE(channelCount * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(dataLength, 40);
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      buf.writeInt16LE(Math.round(s < 0 ? s * 32768 : s * 32767), p);
      p += 2;
    }
  }
  return buf;
}
