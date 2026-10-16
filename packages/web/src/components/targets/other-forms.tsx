import { Link } from 'react-router';
import { useOp } from '../../lib/api';
import { ConnectionPicker } from '../pickers';
import { CodeEditor } from '../ui/code';
import { Field, Input, Textarea } from '../ui/form';
import { NumberInput, ScriptDocs, Section } from './common';
import type { ModelConfig, ScriptConfig } from './model';

export function ModelForm({ value, onChange }: { value: ModelConfig; onChange: (c: ModelConfig) => void }) {
  const set = (patch: Partial<ModelConfig>) => onChange({ ...value, ...patch });
  const connections = useOp<any[]>('list_connections');
  const conn = connections.data?.find((c) => c.id === value.connectionId);
  return (
    <>
      <Section title="Model" help="Tests a prompt directly against a model, without your app in between. Useful for comparing models and prompt versions.">
        {connections.data && connections.data.length === 0 && (
          <div className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
            No connections yet. <Link to="/connections" className="font-medium underline">Add one on the Connections page</Link>.
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Connection" help="The provider account to call (OpenAI, Anthropic, Bedrock, Vertex, a local model, …).">
            <ConnectionPicker value={value.connectionId} onChange={(connectionId) => set({ connectionId })} />
          </Field>
          <Field label="Model" help="Model id as the provider names it. Leave empty to use the connection's default model.">
            <Input mono value={value.model} placeholder={conn?.spec?.defaultModel || 'model id'} onChange={(e) => set({ model: e.target.value })} />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Temperature" help="Randomness from 0 to 2. Leave empty for the model's default.">
            <NumberInput value={value.temperature} min={0} step={0.1} placeholder="default" onChange={(temperature) => set({ temperature })} />
          </Field>
          <Field label="Max output tokens" help="Upper limit on the reply length. Leave empty for the model's default.">
            <NumberInput value={value.maxOutputTokens} min={1} placeholder="default" onChange={(maxOutputTokens) => set({ maxOutputTokens })} />
          </Field>
        </div>
      </Section>
      <Section title="Prompt" help="Templates with {{column}} placeholders. The reply becomes the main output.">
        <Field label="System prompt" help="Optional instructions sent as the system message.">
          <Textarea rows={3} value={value.system} placeholder="You are a helpful support assistant…" onChange={(e) => set({ system: e.target.value })} />
        </Field>
        <Field label="User prompt">
          <CodeEditor value={value.prompt} onChange={(prompt) => set({ prompt })} minHeight={120} placeholder="{{input}}" />
        </Field>
      </Section>
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
