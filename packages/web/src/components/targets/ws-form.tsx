import { Wand2 } from 'lucide-react';
import { Button } from '../ui/button';
import { CodeEditor } from '../ui/code';
import { Field, Input, KeyValueEditor, Segmented, Select, Switch, TagInput } from '../ui/form';
import { Menu, MenuItem } from '../ui/overlay';
import { toast } from '../ui/toast';
import { AuthEditor, ExtractorsEditor, MessagesEditor, NumberInput, ScriptDocs, Section } from './common';
import { applyWsPattern, WS_PATTERNS, type WsConfig } from './model';

const ENCODINGS: { value: WsConfig['audio']['encoding']; label: string; hint: string }[] = [
  { value: 'pcm_s16le', label: 'PCM 16-bit (s16le)', hint: 'Most common raw audio format for streaming speech APIs' },
  { value: 'pcm_f32le', label: 'PCM 32-bit float (f32le)', hint: 'Raw float samples between -1 and 1' },
  { value: 'mulaw', label: 'μ-law (G.711)', hint: 'Telephony, usually 8 kHz' },
  { value: 'alaw', label: 'A-law (G.711)', hint: 'Telephony outside North America, usually 8 kHz' },
  { value: 'file', label: 'Original file bytes', hint: 'Send the uploaded file as-is (e.g. WAV/Opus), split into chunks' },
];

const DONE_WHEN: { value: WsConfig['incoming']['doneWhen']; label: string; hint: string }[] = [
  { value: 'final_after_audio', label: 'A final result arrives after the audio', hint: 'Usual for speech-to-text: stop at the first final once all audio was sent' },
  { value: 'close', label: 'The server closes the connection', hint: 'Wait until the server hangs up' },
  { value: 'expression', label: 'A message matches an expression', hint: 'Write a JS condition on `msg`' },
  { value: 'idle', label: 'No messages for a while', hint: 'Stop after a quiet period' },
];

export function WsForm({ value, onChange }: { value: WsConfig; onChange: (c: WsConfig) => void }) {
  const set = (patch: Partial<WsConfig>) => onChange({ ...value, ...patch });
  const setAudio = (patch: Partial<WsConfig['audio']>) => set({ audio: { ...value.audio, ...patch } });
  const setIn = (patch: Partial<WsConfig['incoming']>) => set({ incoming: { ...value.incoming, ...patch } });
  const a = value.audio;
  const inc = value.incoming;
  const scriptsUsed = !!(value.scripts.onMessage || value.scripts.session);

  return (
    <>
      <Section
        title="Connection"
        help="The WebSocket address of your app. Kalibra opens one connection per dataset row."
        action={
          <Menu
            trigger={
              <Button size="sm" variant="ghost" icon={<Wand2 className="size-3.5" />}>
                Start from a pattern
              </Button>
            }
          >
            {WS_PATTERNS.map((p) => (
              <MenuItem
                key={p.id}
                hint={p.hint}
                onSelect={() => {
                  onChange(applyWsPattern(value, p.id));
                  toast.info(`Applied “${p.label}”`, 'Messages, audio and incoming settings were filled in. Adjust them to match your service.');
                }}
              >
                {p.label}
              </MenuItem>
            ))}
          </Menu>
        }
      >
        <Field label="URL" help="ws:// or wss:// address. Templates work, e.g. {{vars.ws_url}}?language={{lang}}.">
          <Input mono value={value.url} placeholder="wss://example.com/v1/listen" onChange={(e) => set({ url: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Connect timeout (ms)" help="How long to wait for the connection to open.">
            <NumberInput value={value.connectTimeoutMs} min={1} onChange={(v) => set({ connectTimeoutMs: v ?? 10000 })} />
          </Field>
          <Field label="Overall timeout (ms)" help="Maximum time for the whole session of one row, including streaming.">
            <NumberInput value={value.timeoutMs} min={1} onChange={(v) => set({ timeoutMs: v ?? 120000 })} />
          </Field>
        </div>
        <Field label="Subprotocols" help="Optional Sec-WebSocket-Protocol values some services require. Press Enter to add.">
          <TagInput value={value.subprotocols} onChange={(subprotocols) => set({ subprotocols })} placeholder="Add a subprotocol…" />
        </Field>
      </Section>

      <Section title="Query parameters and headers" collapsible defaultOpen={value.query.length + value.headers.length > 0} summary={`${value.query.length} params · ${value.headers.length} headers`}>
        <Field label="Query parameters" help="Added to the URL as ?name=value.">
          <KeyValueEditor value={value.query} onChange={(query) => set({ query })} addLabel="Add parameter" />
        </Field>
        <Field label="Headers" help="Sent with the opening handshake.">
          <KeyValueEditor value={value.headers} onChange={(headers) => set({ headers })} addLabel="Add header" />
        </Field>
      </Section>

      <Section title="Authentication" collapsible defaultOpen={value.auth.type !== 'none'} summary={value.auth.type === 'none' ? 'None' : value.auth.type}>
        <AuthEditor value={value.auth} onChange={(auth) => set({ auth })} />
      </Section>

      <Section title="Messages on open" help="Sent right after the connection opens, in order. Typical use: a start or config message with the sample rate and language.">
        <MessagesEditor value={value.onOpen} onChange={(onOpen) => set({ onOpen })} emptyHint="Nothing is sent before the audio." />
        <Field label="Wait for acknowledgement" help="Optional JS expression on `msg`. If set, Kalibra waits for a matching message (e.g. msg.type === 'ready') before streaming audio.">
          <Input mono value={value.waitForOpenAck} placeholder="msg.type === 'ready'" onChange={(e) => set({ waitForOpenAck: e.target.value })} />
        </Field>
      </Section>

      <Section
        title="Audio streaming"
        help="Streams an audio column to the server in small frames, like a microphone would. Kalibra decodes, resamples and encodes the file to the format you choose."
        action={<Switch checked={a.enabled} onChange={(enabled) => setAudio({ enabled })} label="Stream audio" />}
      >
        {!a.enabled ? (
          <div className="text-[0.78125rem] text-ink-faint">Off. Turn on to stream an audio column (for speech-to-text and voice apps).</div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Audio column" help="Template resolving to the audio file of each row, e.g. {{audio}}.">
                <Input mono value={a.source} placeholder="{{audio}}" onChange={(e) => setAudio({ source: e.target.value })} />
              </Field>
              <Field label="Encoding" help="The audio format your server expects. Pick “Original file bytes” to send the file without converting it.">
                <Select value={a.encoding} onChange={(v) => setAudio({ encoding: v as WsConfig['audio']['encoding'] })} options={ENCODINGS} />
              </Field>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Sample rate (Hz)" help="Audio is resampled to this rate. 16000 is common for speech; telephony uses 8000.">
                <NumberInput value={a.sampleRate} min={1} onChange={(v) => setAudio({ sampleRate: v ?? 16000 })} />
              </Field>
              <Field label="Channels">
                <Select
                  value={String(a.channels)}
                  onChange={(v) => setAudio({ channels: Number(v) })}
                  options={[
                    { value: '1', label: 'Mono' },
                    { value: '2', label: 'Stereo' },
                  ]}
                />
              </Field>
              <Field label="Frame size (ms)" help="Audio duration per message. 20–100 ms is typical.">
                <NumberInput value={a.frameMs} min={1} onChange={(v) => setAudio({ frameMs: v ?? 20 })} />
              </Field>
            </div>
            <Field label="Send frames as" help="Binary: raw bytes in binary WebSocket frames. Text: wrap each chunk in a text message using the template below.">
              <Segmented
                value={a.sendAs}
                onChange={(sendAs) => setAudio({ sendAs })}
                options={[
                  { value: 'binary', label: 'Binary frames' },
                  { value: 'text', label: 'Text messages' },
                ]}
              />
            </Field>
            {a.sendAs === 'text' && (
              <Field
                label="Message template"
                help="Each audio chunk is sent using this template. Variables: {{chunk_base64}}, {{seq}}, {{offset_ms}}, {{is_last}}, plus row columns."
              >
                <CodeEditor value={a.textTemplate} onChange={(textTemplate) => setAudio({ textTemplate })} language="json" minHeight={40} maxHeight={160} />
              </Field>
            )}
            <div className="grid grid-cols-3 gap-3">
              <Field label="Pacing" help="Real time sends audio as fast as someone speaking, so latency numbers are realistic. Fast sends everything at once.">
                <Select
                  value={a.pacing}
                  onChange={(v) => setAudio({ pacing: v as WsConfig['audio']['pacing'] })}
                  options={[
                    { value: 'realtime', label: 'Real time', hint: 'Like a live microphone' },
                    { value: 'fast', label: 'As fast as possible', hint: 'Throughput testing' },
                  ]}
                />
              </Field>
              <Field label="Speed" help="For real-time pacing: 1 is normal speed, 2 is twice as fast.">
                <NumberInput value={a.speed} min={0.1} step={0.1} onChange={(v) => setAudio({ speed: v ?? 1 })} />
              </Field>
              <Field label="Trailing silence (ms)" help="Silence appended after the audio. Helps services that wait for a pause before finalizing.">
                <NumberInput value={a.trailingSilenceMs} min={0} onChange={(v) => setAudio({ trailingSilenceMs: v ?? 0 })} />
              </Field>
            </div>
          </>
        )}
      </Section>

      <Section title="Messages after audio" help="Sent once the last audio frame has gone out, e.g. a stop or end-of-stream message." collapsible defaultOpen={value.afterAudio.length > 0 || a.enabled} summary={`${value.afterAudio.length} message(s)`}>
        <MessagesEditor value={value.afterAudio} onChange={(afterAudio) => set({ afterAudio })} emptyHint="Nothing is sent after the audio." />
      </Section>

      <Section title="Incoming messages" help="How Kalibra reads what the server sends back: where the text is, which results are final, and when the session is over.">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Message format" help="JSON messages are parsed so you can use paths and expressions on them.">
            <Select
              value={inc.format}
              onChange={(v) => setIn({ format: v as WsConfig['incoming']['format'] })}
              options={[
                { value: 'json', label: 'JSON' },
                { value: 'text', label: 'Plain text' },
              ]}
            />
          </Field>
          <Field label="Text path" help="JSONPath of the transcript or reply text in each message, e.g. $.text or $.channel.alternatives[0].transcript.">
            <Input mono value={inc.textPath} placeholder="$.text" onChange={(e) => setIn({ textPath: e.target.value })} />
          </Field>
        </div>
        <Field label="Final result when" help="JS expression on `msg` that is true for final (not partial) results. Leave empty to treat every message with text as final.">
          <Input mono value={inc.isFinal} placeholder="msg.is_final === true" onChange={(e) => setIn({ isFinal: e.target.value })} />
        </Field>
        <Field label="Ignore messages when" help="JS expression on `msg`. Matching messages (heartbeats, metadata) are kept in the log but not used.">
          <Input mono value={inc.ignoreWhen} placeholder="msg.type === 'heartbeat'" onChange={(e) => setIn({ ignoreWhen: e.target.value })} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Session is done when" help="When Kalibra stops listening and scores the row.">
            <Select value={inc.doneWhen} onChange={(v) => setIn({ doneWhen: v as WsConfig['incoming']['doneWhen'] })} options={DONE_WHEN} />
          </Field>
          <Field label="Join final results" help="How several final segments combine into the main output.">
            <Select
              value={inc.join}
              onChange={(v) => setIn({ join: v as WsConfig['incoming']['join'] })}
              options={[
                { value: 'space', label: 'With spaces' },
                { value: 'newline', label: 'One per line' },
                { value: 'concat', label: 'Directly (no separator)' },
                { value: 'last', label: 'Keep only the last' },
              ]}
            />
          </Field>
        </div>
        {inc.doneWhen === 'expression' && (
          <Field label="Done expression" help="JS expression on `msg`; the session ends at the first message where it is true.">
            <Input mono value={inc.doneExpression} placeholder="msg.type === 'session_end'" onChange={(e) => setIn({ doneExpression: e.target.value })} />
          </Field>
        )}
        {inc.doneWhen === 'idle' && (
          <Field label="Quiet period (ms)" help="Stop after this long without any message.">
            <NumberInput value={inc.idleMs} min={1} onChange={(v) => setIn({ idleMs: v ?? 1500 })} />
          </Field>
        )}
      </Section>

      <Section
        title="Extra outputs"
        help="The main output is the joined final text. Add fields computed from the session, e.g. the detected language from the last message."
        collapsible
        defaultOpen={value.outputs.length > 0}
        summary={value.outputs.length ? `${value.outputs.length} field(s)` : 'Only the main output'}
      >
        <ExtractorsEditor value={value.outputs} onChange={(outputs) => set({ outputs })} expressionScope="messages, finals, partials and state" />
      </Section>

      <Section
        title="Scripts (escape hatch)"
        help="JavaScript for protocols the settings above can't describe."
        collapsible
        defaultOpen={scriptsUsed}
        summary={scriptsUsed ? 'In use' : 'Not used'}
      >
        <Field label="On every message" help="Runs for each incoming message. Update `state` and return { partial, final, done, ignore } to steer the session.">
          <ScriptDocs
            items={[
              ['msg', 'The parsed message (or text)'],
              ['state', 'An object kept for the whole session'],
              ['log(...)', 'Write to the run log'],
            ]}
            returns="Return e.g. { final: msg.result.text, done: msg.result.last }."
          />
          <CodeEditor value={value.scripts.onMessage} onChange={(onMessage) => set({ scripts: { ...value.scripts, onMessage } })} language="js" minHeight={80} placeholder="// if (msg.type === 'transcript') return { final: msg.text };" />
        </Field>
        <Field label="Full session (overrides everything above)" help="Write the whole conversation yourself: you get the open socket and helpers, and return the outputs.">
          <ScriptDocs
            items={[
              ['ws', 'The open WebSocket'],
              ['send(data)', 'Send a string, Buffer, or object (as JSON)'],
              ['nextMessage(ms)', 'Wait for the next incoming message'],
              ['sendAudio(opts)', 'Stream the row audio with the settings above'],
              ['render(template)', 'Fill a {{template}} with row values'],
              ['mark(name)', 'Record a timing metric (ms since start)'],
              ['row, vars, state, log', 'Row values, variables, session state, logging'],
            ]}
            returns="Return { output, ...other fields, metrics? }."
          />
          <CodeEditor
            value={value.scripts.session}
            onChange={(session) => set({ scripts: { ...value.scripts, session } })}
            language="js"
            minHeight={80}
            placeholder={"// send({ type: 'start' });\n// await sendAudio();\n// const msg = await nextMessage(5000);\n// return { output: msg.text };"}
          />
        </Field>
      </Section>
    </>
  );
}
