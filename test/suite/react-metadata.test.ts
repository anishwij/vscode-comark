import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as vscode from 'vscode';

suite('Packaged React metadata discovery', function () {
  this.timeout(30000);
  let root: string;
  let originalMetadata: Buffer;
  let adapter: { getReactMetadata(config: string): Promise<unknown> };
  let counter = 0;
  const label = (item: vscode.CompletionItem) => typeof item.label === 'string' ? item.label : (item.label as { label: string }).label;
  const values = (items: vscode.CompletionItem[]) => items.filter(item => item.kind === vscode.CompletionItemKind.EnumMember).map(label).sort();

  async function request(content = '::card{variant="¦"}', directory = root) {
    const cursor = content.indexOf('¦');
    const uri = vscode.Uri.file(path.join(directory, `probe-${counter++}.md`));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content.replace('¦', '')));
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(document, 'mdc');
    const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri, document.positionAt(cursor));
    return { document, position: document.positionAt(cursor), items: list?.items ?? [] };
  }
  async function accept(content: string, name: string, kind = vscode.CompletionItemKind.Property) {
    const result = await request(content);
    const item = result.items.find(item => label(item) === name && item.kind === kind)!;
    assert.ok(item, `Missing ${name}`);
    assert.ok(item.range instanceof vscode.Range && item.range.contains(result.position));
    if (item.insertText instanceof vscode.SnippetString) {
      const editor = await vscode.window.showTextDocument(result.document);
      await editor.insertSnippet(item.insertText, item.range);
    } else {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(result.document.uri, item.range, item.insertText as string);
      assert.ok(await vscode.workspace.applyEdit(edit));
    }
    return result.document.getText();
  }
  async function waitFor(expected: string[]) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const result = await request();
      if (JSON.stringify(values(result.items)) === JSON.stringify(expected)) { return; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('Metadata choices did not update');
  }
  async function save(file: string, content: string) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), content);
    await vscode.workspace.applyEdit(edit);
    await document.save();
  }

  suiteSetup(async () => {
    root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    originalMetadata = fs.readFileSync(path.join(root, 'component-metadata.json'));
    fs.unlinkSync(path.join(root, 'component-metadata.json'));
    const extension = vscode.extensions.getExtension('Nuxt.mdc')!;
    await extension.activate();
    assert.ok(fs.existsSync(path.join(extension.extensionPath, 'node_modules/typescript/lib/lib.es5.d.ts')));
    adapter = require(path.join(extension.extensionPath, 'out/utils/react/metadata.js'));
    const config = vscode.workspace.getConfiguration('mdc');
    await config.update('componentMetadataLocalFilePattern', 'component-metadata.json', vscode.ConfigurationTarget.Workspace);
    await config.update('enableComponentMetadataCompletions', true, vscode.ConfigurationTarget.Workspace);
    await waitFor(['"muted"', '"outline"']);
  });
  suiteTeardown(async () => {
    fs.writeFileSync(path.join(root, 'component-metadata.json'), originalMetadata);
    const config = vscode.workspace.getConfiguration('mdc');
    await config.update('enableComponentMetadataCompletions', undefined, vscode.ConfigurationTarget.Workspace);
    await config.update('componentMetadataLocalFilePattern', undefined, vscode.ConfigurationTarget.Workspace);
    await config.update('componentMetadataURL', undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('supplies source-discovered names and values through the registered providers', async () => {
    const names = await request('::ca¦');
    assert.ok(names.items.some(item => label(item) === 'card' && item.kind === vscode.CompletionItemKind.Function));
    const props = await request('::card{v¦}');
    const variant = props.items.find(item => label(item) === 'variant')!;
    assert.ok(variant);
    const editor = await vscode.window.showTextDocument(props.document);
    assert.ok(variant.range instanceof vscode.Range);
    await editor.insertSnippet(variant.insertText as vscode.SnippetString, variant.range);
    assert.strictEqual(props.document.getText(), '::card{variant=""}');
    assert.deepStrictEqual(values((await request('::card\n---\nvariant: o¦\n---\n::')).items), ['"muted"', '"outline"']);
  });

  test('inserts exact React prop names in attributes and YAML with PascalCase registrations', async () => {
    for (const [source, name, expected] of [
      ['::card{cla¦}', 'className', '::card{className=""}'],
      ['::Card{tit¦}', 'titleText', '::Card{titleText=""}'],
      ['::card{classNa¦me="Keep"}', 'className', '::card{className="Keep"}'],
      ['::card\n---\ncla¦\n---\n::', 'className', '::card\n---\nclassName: ""\n---\n::'],
      ['::card\n---\ndefaultOp¦en: false\n---\n::', 'defaultOpen', '::card\n---\ndefaultOpen: false\n---\n::'],
    ]) {
      assert.strictEqual(await accept(source, name), expected);
    }
    for (const [source, expected] of [
      ['::card{titleText="lo¦" title="Keep"}', '::card{titleText="long" title="Keep"}'],
      ['::Card\n---\ntitleText: lo¦ # note\n---\n::', '::Card\n---\ntitleText: "long" # note\n---\n::'],
    ]) {
      assert.strictEqual(await accept(source, '"long"', vscode.CompletionItemKind.EnumMember), expected);
    }
  });

  test('matches and suppresses React props by exact key rather than camel/kebab equivalence', async () => {
    for (const [key, expected] of [['titleText', ['"long"', '"short"']], ['title-text', ['"hyphen"']]] as const) {
      assert.deepStrictEqual(values((await request(`::card{${key}="¦"}`)).items), [...expected]);
      assert.deepStrictEqual(values((await request(`::card\n---\n${key}: ¦\n---\n::`)).items), [...expected]);
    }
    for (const source of ['::card{title-text="hyphen" tit¦}', '::card\n---\ntitle-text: hyphen\ntit¦\n---\n::']) {
      const items = (await request(source)).items;
      assert.ok(items.some(item => label(item) === 'titleText'));
      assert.ok(!items.some(item => label(item) === 'title-text'));
    }
    for (const source of ['::card{titleText="short" tit¦}', '::card\n---\ntitleText: short\ntit¦\n---\n::']) {
      const items = (await request(source)).items;
      assert.ok(items.some(item => label(item) === 'title-text'));
      assert.ok(!items.some(item => label(item) === 'titleText'));
    }
    assert.deepStrictEqual(values((await request('::card{class-name="¦"}')).items), []);
  });

  test('keeps Markdown saves warm and refreshes source and registration create/delete events', async () => {
    const config = path.join(root, 'tsconfig.json');
    const before = await adapter.getReactMetadata(config);
    const probe = await request();
    await probe.document.save();
    assert.strictEqual(await adapter.getReactMetadata(config), before);
    const file = path.join(root, 'src/card.tsx');
    const original = fs.readFileSync(file, 'utf8');
    try {
      await save(file, original.replace("muted: ''", "fresh: ''"));
      await waitFor(['"fresh"', '"outline"']);
    } finally {
      await save(file, original);
      await waitFor(['"muted"', '"outline"']);
    }
    const registration = path.join(root, 'src/extra.tsx');
    try {
      await vscode.workspace.fs.writeFile(vscode.Uri.file(registration), Buffer.from("import { MarkdownDocument } from '@comark/react'; import { ActualFileName } from './card'; export const view = <MarkdownDocument components={{ extra: ActualFileName }} />"));
      const deadline = Date.now() + 10000;
      let found = false;
      while (Date.now() < deadline) {
        const result = await request('::ex¦');
        if (result.items.some(item => label(item) === 'extra')) { found = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(found);
    } finally { await vscode.workspace.fs.delete(vscode.Uri.file(registration)); }
    await vscode.commands.executeCommand('mdc.refreshMetadata');
    assert.ok(!(await request('::ex¦')).items.some(item => label(item) === 'extra'));
  });

  test('refreshes a saved inherited props dependency outside the workspace project', async () => {
    const base = path.join(root, 'src/base.ts');
    const original = fs.readFileSync(base, 'utf8');
    const shared = path.join(root, '..', `shared-${Date.now()}.ts`);
    fs.writeFileSync(shared, "export interface Base { title: string; size?: 'before' }");
    try {
      await save(base, `export { Base } from '${shared.replaceAll('\\', '/')}'`);
      await vscode.commands.executeCommand('mdc.refreshMetadata');
      assert.deepStrictEqual(values((await request('::card{size="¦"}')).items), ['"before"']);
      await save(shared, "export interface Base { title: string; size?: 'after' }");
      const deadline = Date.now() + 10000;
      let changed = false;
      while (Date.now() < deadline) {
        if (values((await request('::card{size="¦"}')).items).includes('"after"')) { changed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(changed, 'Outer metadata scope must invalidate along with its consuming project');
    } finally { await save(base, original); fs.unlinkSync(shared); }
  });

  test('preserves configured JSON/Nuxt metadata preference and URL authority', async () => {
    const custom = JSON.parse(originalMetadata.toString());
    custom[0].component_meta.meta.props[0].schema.schema = ['"supplied"'];
    fs.writeFileSync(path.join(root, 'component-metadata.json'), JSON.stringify(custom));
    try {
      await vscode.commands.executeCommand('mdc.refreshMetadata');
      await waitFor(['"supplied"']);
    } finally { fs.unlinkSync(path.join(root, 'component-metadata.json')); }
    const nuxt = path.join(root, '.nuxt/component-meta.mjs');
    fs.mkdirSync(path.dirname(nuxt), { recursive: true });
    fs.writeFileSync(nuxt, 'export default ' + JSON.stringify({ Card: { pascalName: 'Card', meta: custom[0].component_meta.meta } }, null, 2));
    const config = vscode.workspace.getConfiguration('mdc');
    try {
      await config.update('componentMetadataLocalFilePattern', '**/.nuxt/component-meta.mjs', vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('mdc.refreshMetadata');
      await waitFor(['"supplied"']);
    } finally {
      fs.unlinkSync(nuxt);
      await config.update('componentMetadataLocalFilePattern', 'component-metadata.json', vscode.ConfigurationTarget.Workspace);
    }
    const server = http.createServer((_request, response) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(custom)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      await config.update('componentMetadataURL', `http://127.0.0.1:${address.port}/metadata`, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('mdc.refreshMetadata');
      await waitFor(['"supplied"']);
      await config.update('componentMetadataURL', `http://127.0.0.1:${address.port}/missing`, vscode.ConfigurationTarget.Workspace);
      server.removeAllListeners('request');
      server.on('request', (_request, response) => { response.statusCode = 500; response.end(); });
      await vscode.commands.executeCommand('mdc.refreshMetadata');
      assert.deepStrictEqual(values((await request()).items), []);
    } finally {
      server.close();
      await config.update('componentMetadataURL', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('honors folder opt-in and isolates derived caches for same-tag multi-root metadata', async () => {
    const secondary = fs.mkdtempSync(path.join(root, '..', 'secondary-'));
    const makeMetadata = (type: string, docs: string, nested: string) => [{ mdc_name: 'card', docs_url: docs, component_meta: { meta: { type: 2, props: [
      { name: 'shared', type, schema: type, description: docs, required: false },
      { name: 'options', type: 'object', schema: { kind: 'enum', schema: [{ kind: 'object', schema: { [nested]: { type: 'string', description: docs } } }] } },
    ], slots: [], events: [], exposed: [] } } }];
    fs.writeFileSync(path.join(root, 'component-metadata.json'), JSON.stringify(makeMetadata('string', 'https://example.com/first', 'first')));
    fs.writeFileSync(path.join(secondary, 'component-metadata.json'), JSON.stringify(makeMetadata('boolean', 'https://example.com/second', 'second')));
    await new Promise<void>(resolve => {
      const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => { subscription.dispose(); resolve(); });
      assert.ok(vscode.workspace.updateWorkspaceFolders(1, 0, { uri: vscode.Uri.file(secondary) }));
    });
    const firstConfig = vscode.workspace.getConfiguration('mdc', vscode.Uri.file(path.join(root, 'config-probe.md')));
    const secondConfig = vscode.workspace.getConfiguration('mdc', vscode.Uri.file(path.join(secondary, 'config-probe.md')));
    try {
      await vscode.workspace.getConfiguration('mdc').update('enableComponentMetadataCompletions', undefined, vscode.ConfigurationTarget.Workspace);
      await firstConfig.update('componentMetadataLocalFilePattern', 'component-metadata.json', vscode.ConfigurationTarget.WorkspaceFolder);
      await secondConfig.update('componentMetadataLocalFilePattern', 'component-metadata.json', vscode.ConfigurationTarget.WorkspaceFolder);
      await firstConfig.update('enableComponentMetadataCompletions', true, vscode.ConfigurationTarget.WorkspaceFolder);
      assert.ok((await request('::card{sha¦}')).items.some(item => label(item) === 'shared'));
      assert.ok(!(await request('::card{sha¦}', secondary)).items.some(item => label(item) === 'shared'));
      await secondConfig.update('enableComponentMetadataCompletions', true, vscode.ConfigurationTarget.WorkspaceFolder);
      for (const [directory, expected, nested, docs] of [[root, 'shared="${0:}"', 'first', 'https://example.com/first'], [secondary, 'shared', 'second', 'https://example.com/second'], [root, 'shared="${0:}"', 'first', 'https://example.com/first']]) {
        const result = await request('::card{sha¦}', directory);
        const item = result.items.find(item => label(item) === 'shared')!;
        assert.strictEqual((item.insertText as vscode.SnippetString).value, expected);
        assert.ok((item.documentation as vscode.MarkdownString).value.includes(docs));
        const keys = await request('::card\n---\noptions:\n  ¦\n---\n::', directory);
        assert.ok(keys.items.some(item => label(item) === nested));
      }
    } finally {
      try {
        await firstConfig.update('enableComponentMetadataCompletions', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
        await secondConfig.update('enableComponentMetadataCompletions', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      } finally {
        await new Promise<void>(resolve => {
          const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => { subscription.dispose(); resolve(); });
          assert.ok(vscode.workspace.updateWorkspaceFolders(1, 1));
        });
        fs.unlinkSync(path.join(root, 'component-metadata.json'));
        await vscode.workspace.getConfiguration('mdc').update('enableComponentMetadataCompletions', true, vscode.ConfigurationTarget.Workspace);
      }
    }
  });
  test('preserves explicitly configured workspace-wide metadata globs across nested tsconfigs', async () => {
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'tsconfig.json'), JSON.stringify({ files: ['index.ts'], compilerOptions: { types: [] } }));
    fs.writeFileSync(path.join(nested, 'index.ts'), 'export const value = 1');
    fs.writeFileSync(path.join(root, 'component-metadata.json'), originalMetadata);
    const config = vscode.workspace.getConfiguration('mdc');
    try {
      await config.update('componentMetadataLocalFilePattern', '**/component-metadata.json', vscode.ConfigurationTarget.Workspace);
      const result = await request('::card{long-v¦}', nested);
      const item = result.items.find(item => label(item) === 'long-variant')!;
      assert.ok(item, 'Workspace-root custom metadata must remain available to the nested project');
      assert.deepStrictEqual(values((await request('::card{variant="¦"}', nested)).items), ['"default"', '"muted"', '"outline"']);
    } finally {
      fs.unlinkSync(path.join(root, 'component-metadata.json'));
      fs.rmSync(nested, { recursive: true, force: true });
      await config.update('componentMetadataLocalFilePattern', 'component-metadata.json', vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('mdc.refreshMetadata');
    }
  });

});
