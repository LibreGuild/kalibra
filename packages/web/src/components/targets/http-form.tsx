import { useState } from 'react';
import { FileDown, Plus, Trash2 } from 'lucide-react';
import { op } from '../../lib/api';
import { Button } from '../ui/button';
import { CodeEditor } from '../ui/code';
import { Field, Input, KeyValueEditor, Segmented, Select, Switch, Textarea } from '../ui/form';
import { Dialog } from '../ui/overlay';
import { toast, toastError } from '../ui/toast';
import { AuthEditor, ExtractorsEditor, NumberInput, ScriptDocs, Section } from './common';
import type { HttpConfig, MultipartPart } from './model';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export function HttpForm({ value, onChange }: { value: HttpConfig; onChange: (c: HttpConfig) => void }) {
  const [curlOpen, setCurlOpen] = useState(false);
  const set = (patch: Partial<HttpConfig>) => onChange({ ...value, ...patch });
  const setBody = (patch: Partial<HttpConfig['body']>) => set({ body: { ...value.body, ...patch } });
  const enabledCount = (kv: { enabled: boolean; key: string }[]) => kv.filter((k) => k.enabled && k.key).length;

  return (
    <>
      <Section
        title="Request"
        help="Where and how Kalibra calls your app for each dataset row. Use {{column}} to insert row values and {{vars.name}} for variables."
        action={
          <Button size="sm" variant="ghost" icon={<FileDown className="size-3.5" />} onClick={() => setCurlOpen(true)}>
            Import cURL
          </Button>
        }
      >
        <div className="grid grid-cols-[120px_1fr] gap-3">
          <Field label="Method">
            <Select value={value.method} onChange={(v) => set({ method: v })} options={METHODS.map((m) => ({ value: m, label: m }))} />
          </Field>
          <Field label="URL" help="Full address of the endpoint. Variables like {{vars.base_url}} let you switch between local, staging and production.">
            <Input mono value={value.url} placeholder="{{vars.base_url}}/api/chat" onChange={(e) => set({ url: e.target.value })} />
          </Field>
        </div>
      </Section>

      <Section title="Query parameters" help="Added to the URL as ?name=value. Values are URL-encoded for you." collapsible defaultOpen={enabledCount(value.query) > 0} summary={`${enabledCount(value.query)} set`}>
        <KeyValueEditor value={value.query} onChange={(query) => set({ query })} addLabel="Add parameter" />
      </Section>

      <Section title="Headers" help="Sent with every request. Templates work here too, e.g. X-Request-Id: {{$uuid}}." collapsible defaultOpen summary={`${enabledCount(value.headers)} set`}>
        <KeyValueEditor value={value.headers} onChange={(headers) => set({ headers })} addLabel="Add header" />
      </Section>

      <Section title="Authentication" collapsible defaultOpen={value.auth.type !== 'none'} summary={value.auth.type === 'none' ? 'None' : value.auth.type}>
        <AuthEditor value={value.auth} onChange={(auth) => set({ auth })} />
      </Section>

      <Section title="Body" help="What is sent as the request body. JSON bodies: {{var}} inside quotes is escaped for you; use {{var | json}} to insert objects, arrays or numbers as raw JSON.">
        <Segmented
          value={value.body.type}
          onChange={(type) => setBody({ type })}
          options={[
            { value: 'none', label: 'None' },
            { value: 'json', label: 'JSON' },
            { value: 'text', label: 'Text' },
            { value: 'form', label: 'Form' },
            { value: 'multipart', label: 'Multipart' },
            { value: 'binary', label: 'File' },
          ]}
        />
        {(value.body.type === 'json' || value.body.type === 'text') && (
          <>
            <CodeEditor
              value={value.body.content}
              onChange={(content) => setBody({ content })}
              language={value.body.type === 'json' ? 'json' : 'text'}
              minHeight={120}
              placeholder={value.body.type === 'json' ? '{\n  "message": "{{input}}"\n}' : 'Text body with {{placeholders}}'}
            />
            <Field label="Content type" help="Leave empty to use the default (application/json for JSON, text/plain for text).">
              <Input mono value={value.body.contentType} placeholder={value.body.type === 'json' ? 'application/json' : 'text/plain'} onChange={(e) => setBody({ contentType: e.target.value })} />
            </Field>
          </>
        )}
        {value.body.type === 'form' && <KeyValueEditor value={value.body.form} onChange={(form) => setBody({ form })} addLabel="Add field" />}
        {value.body.type === 'multipart' && <PartsEditor value={value.body.parts} onChange={(parts) => setBody({ parts })} />}
        {value.body.type === 'binary' && (
          <Field label="File" help="The raw bytes of a file column are sent as the body, e.g. {{audio}} for an audio column.">
            <Input mono value={value.body.binary} placeholder="{{audio}}" onChange={(e) => setBody({ binary: e.target.value })} />
          </Field>
        )}
      </Section>

      <Section
        title="Response streaming"
        help="Turn this on when your endpoint streams its answer (Server-Sent Events or one JSON object per line). Kalibra joins the text pieces and measures time to first token."
        collapsible
        defaultOpen={value.streaming.mode !== 'none'}
        summary={value.streaming.mode === 'none' ? 'Off' : value.streaming.mode.toUpperCase()}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Mode">
            <Select
              value={value.streaming.mode}
              onChange={(mode) => set({ streaming: { ...value.streaming, mode: mode as HttpConfig['streaming']['mode'] } })}
              options={[
                { value: 'none', label: 'Off', hint: 'Read the whole response at once' },
                { value: 'sse', label: 'Server-Sent Events', hint: 'data: {...} lines' },
                { value: 'ndjson', label: 'Newline-delimited JSON', hint: 'One JSON object per line' },
              ]}
            />
          </Field>
          <Field label="Text path" help="JSONPath of the text inside each event, e.g. $.choices[0].delta.content for OpenAI-style streams.">
            <Input mono value={value.streaming.textPath} placeholder="$.choices[0].delta.content" disabled={value.streaming.mode === 'none'} onChange={(e) => set({ streaming: { ...value.streaming, textPath: e.target.value } })} />
          </Field>
        </div>
        <Field label="Stop when" help="Optional JS expression on `event`. Reading stops when it is true, e.g. event.done === true.">
          <Input mono value={value.streaming.doneWhen} placeholder="event.done === true" disabled={value.streaming.mode === 'none'} onChange={(e) => set({ streaming: { ...value.streaming, doneWhen: e.target.value } })} />
        </Field>
      </Section>

      <Section
        title="Outputs"
        help="Named values pulled out of the response. The field called “output” is the main one: checks compare it with expected values unless told otherwise. Add more fields (sources, confidence, …) to check them separately."
      >
        <ExtractorsEditor value={value.outputs} onChange={(outputs) => set({ outputs })} expressionScope="body, text, status, headers and messages" />
      </Section>

      <Section title="Advanced" collapsible defaultOpen={false} summary={`Timeout ${Math.round(value.timeoutMs / 1000)} s`}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Timeout (ms)" help="How long to wait for the full response before giving up on a row.">
            <NumberInput value={value.timeoutMs} min={1} onChange={(v) => set({ timeoutMs: v ?? 60000 })} />
          </Field>
          <Field label="Follow redirects" help="Follow 3xx redirects automatically. Turn off to test the redirect response itself.">
            <div className="flex h-8.5 items-center">
              <Switch checked={value.followRedirects} onChange={(followRedirects) => set({ followRedirects })} label="Follow redirects" />
            </div>
          </Field>
        </div>
      </Section>

      <Section
        title="Scripts (escape hatch)"
        help="Plain JavaScript for anything the form can't express: request signing, custom auth, unusual response formats."
        collapsible
        defaultOpen={!!(value.scripts.beforeRequest || value.scripts.afterResponse)}
        summary={value.scripts.beforeRequest || value.scripts.afterResponse ? 'In use' : 'Not used'}
      >
        <Field label="Before request" help="Runs before each call. Change `request` (url, method, headers, body) and return it.">
          <ScriptDocs
            items={[
              ['request', '{ url, method, headers, body } about to be sent'],
              ['row, vars', 'The dataset row and target variables'],
              ['crypto, Buffer', 'Node crypto and Buffer, e.g. for HMAC signing'],
              ['log(...)', 'Write to the run log (console.log works too)'],
            ]}
            returns="Return the (modified) request."
          />
          <CodeEditor
            value={value.scripts.beforeRequest}
            onChange={(beforeRequest) => set({ scripts: { ...value.scripts, beforeRequest } })}
            language="js"
            minHeight={90}
            placeholder={"// request.headers['x-signature'] = crypto.createHmac('sha256', vars.key).update(request.body).digest('hex');\n// return request;"}
          />
        </Field>
        <Field label="After response" help="Runs after the response. Return an object; its keys become extra output fields.">
          <ScriptDocs
            items={[
              ['response', '{ status, headers, body, text }'],
              ['outputs', 'Fields already extracted above'],
              ['row, vars, log', 'As above'],
            ]}
            returns="Return e.g. { output: response.body.answer.trim(), sources: response.body.sources }."
          />
          <CodeEditor
            value={value.scripts.afterResponse}
            onChange={(afterResponse) => set({ scripts: { ...value.scripts, afterResponse } })}
            language="js"
            minHeight={90}
            placeholder="// return { output: response.body.answer };"
          />
        </Field>
      </Section>

      <CurlDialog
        open={curlOpen}
        onOpenChange={setCurlOpen}
        onImport={(parsed) => {
          onChange({ ...value, ...parsed, kind: 'http', outputs: value.outputs.length ? value.outputs : parsed.outputs, scripts: value.scripts });
          setCurlOpen(false);
          toast.success('Request imported', 'Method, URL, headers, auth and body were replaced. Outputs and scripts were kept.');
        }}
      />
    </>
  );
}

function PartsEditor({ value, onChange }: { value: MultipartPart[]; onChange: (v: MultipartPart[]) => void }) {
  const set = (i: number, patch: Partial<MultipartPart>) => onChange(value.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <div className="grid grid-cols-[130px_100px_1fr_120px_32px] gap-2 text-[12px] font-medium text-ink-faint">
          <span>Field name</span>
          <span>Kind</span>
          <span>Value</span>
          <span>File name</span>
          <span />
        </div>
      )}
      {value.map((p, i) => (
        <div key={i} className="grid grid-cols-[130px_100px_1fr_120px_32px] items-center gap-2">
          <Input mono value={p.name} placeholder="file" onChange={(e) => set(i, { name: e.target.value })} />
          <Select
            value={p.kind}
            onChange={(kind) => set(i, { kind: kind as MultipartPart['kind'] })}
            options={[
              { value: 'text', label: 'Text' },
              { value: 'file', label: 'File' },
            ]}
          />
          <Input mono value={p.value} placeholder={p.kind === 'file' ? '{{audio}}' : '{{language}}'} onChange={(e) => set(i, { value: e.target.value })} />
          <Input mono value={p.filename} placeholder={p.kind === 'file' ? 'original' : '—'} disabled={p.kind !== 'file'} onChange={(e) => set(i, { filename: e.target.value })} />
          <Button variant="ghost" size="icon-sm" aria-label="Remove part" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      ))}
      <div className="text-[12px] text-ink-faint">File parts take a file column, e.g. {'{{audio}}'}; the file name defaults to the uploaded name.</div>
      <div>
        <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" />} onClick={() => onChange([...value, { name: '', kind: 'text', value: '', filename: '', contentType: '' }])}>
          Add part
        </Button>
      </div>
    </div>
  );
}

function CurlDialog({ open, onOpenChange, onImport }: { open: boolean; onOpenChange: (o: boolean) => void; onImport: (c: HttpConfig) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Import a cURL command"
      description="Paste a request copied from browser devtools (“Copy as cURL”), Postman or API docs."
      width="lg"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!text.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                onImport(await op<HttpConfig>('parse_curl', { command: text }));
                setText('');
              } catch (e) {
                toastError(e, 'Could not read that command');
              } finally {
                setBusy(false);
              }
            }}
          >
            Import
          </Button>
        </>
      }
    >
      <Textarea mono rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={"curl -X POST https://api.example.com/chat \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"message\": \"hello\"}'"} />
      <div className="mt-2 text-[12.5px] text-ink-faint">After importing, replace literal values with {'{{column}}'} placeholders and move tokens into secrets.</div>
    </Dialog>
  );
}
