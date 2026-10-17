import { Link } from '../../lib/nav';
import { useOp } from '../../lib/api';
import { ConnectionPicker } from '../pickers';
import { CodeEditor } from '../ui/code';
import { Field, Input, Segmented, Select, Textarea } from '../ui/form';
import { NumberInput, ScriptDocs, Section } from './common';
import type { ModelConfig, ModelTask, ScriptConfig } from './model';

const TASKS: { value: ModelTask; label: string }[] = [
  { value: 'text', label: 'Text' },
  { value: 'image', label: 'Image' },
  { value: 'speech', label: 'Speech (TTS)' },
  { value: 'transcription', label: 'Transcription' },
];

const TASK_HELP: Record<ModelTask, string> = {
  text: 'Sends the prompt and keeps the reply as the output.',
  image: 'Draws an image from the prompt; the image becomes the output, so checks like an LLM judge with attachments can grade it.',
  speech: 'Reads the prompt aloud; the audio file becomes the output.',
  transcription: "Transcribes an audio column; the text becomes the output. Handy as a baseline next to your own speech-to-text service.",
};

const modelFor = (spec: any, task: ModelTask) =>
  (task === 'image' ? spec?.imageModel : task === 'speech' ? spec?.speechModel : task === 'transcription' ? spec?.transcriptionModel : '') || spec?.defaultModel || '';

export function ModelForm({ value, onChange }: { value: ModelConfig; onChange: (c: ModelConfig) => void }) {
  const set = (patch: Partial<ModelConfig>) => onChange({ ...value, ...patch });
  const connections = useOp<any[]>('list_connections');
  const conn = connections.data?.find((c) => c.id === value.connectionId);
  const task: ModelTask = value.task ?? 'text';
  return (
    <>
      <Section title="Model" help="Tests a model directly, without your app in between. Useful for comparing models, prompt versions, or a provider's speech-to-text against your own.">
        {connections.data && connections.data.length === 0 && (
          <div className="rounded-lg bg-warn-soft px-3 py-2 text-[0.78125rem] text-warn">
            No connections yet. <Link to="/connections" className="font-medium underline">Add one on the Connections page</Link>.
          </div>
        )}
        <Field label="Task" help={TASK_HELP[task]}>
          <Segmented<ModelTask> value={task} onChange={(t) => set({ task: t })} options={TASKS} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Connection" help="The provider account to call (OpenAI, Anthropic, Gemini, Bedrock, Vertex, a local model, …).">
            <ConnectionPicker value={value.connectionId} onChange={(connectionId) => set({ connectionId })} />
          </Field>
          <Field label="Model" help="Model id as the provider names it. Leave empty to use the connection's model for this task.">
            <Input mono value={value.model} placeholder={modelFor(conn?.spec, task) || 'model id'} onChange={(e) => set({ model: e.target.value })} />
          </Field>
        </div>
        {task === 'text' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Temperature" help="Randomness from 0 to 2. Leave empty for the model's default.">
              <NumberInput value={value.temperature} min={0} step={0.1} placeholder="default" onChange={(temperature) => set({ temperature })} />
            </Field>
            <Field label="Max output tokens" help="Upper limit on the reply length. Leave empty for the model's default.">
              <NumberInput value={value.maxOutputTokens} min={1} placeholder="default" onChange={(maxOutputTokens) => set({ maxOutputTokens })} />
            </Field>
          </div>
        )}
        {task === 'image' && (
          <div className="grid grid-cols-3 gap-3">
            <Field label="Size" help="Pixel size, e.g. 1024x1024 or 1536x1024. Leave empty for the model default.">
              <Input mono value={value.size ?? ''} placeholder="default" onChange={(e) => set({ size: e.target.value })} />
            </Field>
            <Field label="Aspect ratio" help="For models that take a ratio instead of a size (e.g. Imagen), like 16:9.">
              <Input mono value={value.aspectRatio ?? ''} placeholder="default" onChange={(e) => set({ aspectRatio: e.target.value })} />
            </Field>
            <Field label="Quality" help="OpenAI / Azure image quality. Higher costs more and takes longer.">
              <Select
                value={value.quality || 'default'}
                onChange={(q) => set({ quality: q === 'default' ? '' : (q as ModelConfig['quality']) })}
                options={[
                  { value: 'default', label: 'Default' },
                  { value: 'low', label: 'Low' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'high', label: 'High' },
                ]}
              />
            </Field>
          </div>
        )}
        {task === 'speech' && (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Voice" help="Voice name as the provider calls it, e.g. alloy, coral or nova for OpenAI.">
              <Input mono value={value.voice ?? ''} placeholder="provider default" onChange={(e) => set({ voice: e.target.value })} />
            </Field>
            <Field label="Speaking instructions" help="Tone, accent or pace for models that accept instructions. {{column}} placeholders work.">
              <Input value={value.instructions ?? ''} placeholder="e.g. Calm, slightly slow" onChange={(e) => set({ instructions: e.target.value })} />
            </Field>
          </div>
        )}
      </Section>
      {task === 'transcription' ? (
        <Section title="Audio" help="Which column holds the audio to transcribe. The transcript becomes the main output.">
          <Field label="Audio column" help="A template that resolves to an audio file, usually {{audio}}.">
            <Input mono value={value.audio ?? '{{audio}}'} onChange={(e) => set({ audio: e.target.value })} />
          </Field>
        </Section>
      ) : (
        <Section
          title={task === 'image' ? 'Image prompt' : task === 'speech' ? 'Text to speak' : 'Prompt'}
          help={task === 'text' ? 'Templates with {{column}} placeholders. The reply becomes the main output.' : 'A template with {{column}} placeholders, rendered for every row.'}
        >
          {task === 'text' && (
            <Field label="System prompt" help="Optional instructions sent as the system message.">
              <Textarea rows={3} value={value.system} placeholder="You are a helpful support assistant…" onChange={(e) => set({ system: e.target.value })} />
            </Field>
          )}
          <Field label={task === 'text' ? 'User prompt' : undefined}>
            <CodeEditor
              value={value.prompt}
              onChange={(prompt) => set({ prompt })}
              minHeight={task === 'text' ? 120 : 80}
              placeholder={task === 'image' ? 'A product photo of {{item}} on a white background' : task === 'speech' ? '{{reference}}' : '{{input}}'}
            />
          </Field>
        </Section>
      )}
    </>
  );
}

export function ScriptForm({ value, onChange }: { value: ScriptConfig; onChange: (c: ScriptConfig) => void }) {
  return (
    <Section title="Script" help="Plain JavaScript that calls your app any way you like. Whatever it returns becomes the outputs for the row.">
      <ScriptDocs
        items={[
          ['row', 'The dataset row, e.g. row.input'],
          ['vars', 'Target variables, e.g. vars.base_url'],
          ['fetch', 'Standard fetch for HTTP calls'],
          ['WebSocket', 'WebSocket client (the ws package)'],
          ['readFile(file)', 'Bytes of a file column, e.g. await readFile(row.audio)'],
          ['secret(name)', 'A stored secret, e.g. await secret("api_key"). Masked in logs'],
          ['llm', 'Configured model connections (llm.text / llm.json)'],
          ['log(...)', 'Write to the run log'],
          ['require(...)', 'Node built-ins and packages in the workspace'],
        ]}
        returns={
          <>
            Return <code className="font-mono">{'{ output, ...other fields }'}</code> or a plain string. A <code className="font-mono">metrics</code> object in the result adds custom metrics.
          </>
        }
      />
      <CodeEditor value={value.code} onChange={(code) => onChange({ ...value, code })} language="js" minHeight={320} maxHeight={720} />
      <div className="w-56">
        <Field label="Timeout (ms)" help="The script is stopped after this long.">
          <NumberInput value={value.timeoutMs} min={1} onChange={(v) => onChange({ ...value, timeoutMs: v ?? 60000 })} />
        </Field>
      </div>
    </Section>
  );
}
