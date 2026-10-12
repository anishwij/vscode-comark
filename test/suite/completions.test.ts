import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Component prop completions', function () {
  this.timeout(10000);
  let metadataUri: vscode.Uri;
  let originalMetadata: Uint8Array;

  async function request(content: string, trigger?: string) {
    const offset = content.indexOf('¦');
    assert.ok(offset >= 0, 'The test must specify a cursor');
    const document = await vscode.workspace.openTextDocument({ language: 'mdc', content: content.replace('¦', '') });
    const position = document.positionAt(offset);
    const result = await vscode.commands.executeCommand<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider', document.uri, position, trigger
    );
    return { document, position, items: result?.items ?? [] };
  }

  function label(item: vscode.CompletionItem) {
    return typeof item.label === 'string' ? item.label : (item.label as { label: string }).label;
  }

  async function accept(content: string, choice: string, kind = vscode.CompletionItemKind.EnumMember) {
    const result = await request(content);
    const item = result.items.find(candidate => label(candidate) === choice && candidate.kind === kind);
    assert.ok(item, `Missing ${choice} in ${JSON.stringify(result.items.map(label))}`);
    assert.ok(item.range instanceof vscode.Range);
    assert.ok(item.range.contains(result.position), 'Completion range must contain the request position');
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

  const values = (items: vscode.CompletionItem[]) => items.filter(item => item.kind === vscode.CompletionItemKind.EnumMember).map(label).sort();

  test('completes YAML after indented literal fences without changing code or comments', async () => {
    for (const marker of ['```', '~~~yaml [props]']) {
      const source = `    ${marker}\n\n::card\n---\nvariant: o¦ # note\n---\n::`;
      assert.strictEqual(await accept(source, '"outline"'), source.replace('o¦', '"outline"'));
    }
  });

  test('applies inline component prop and value edits inside rendered Markdown wrappers', async () => {
    for (const wrap of ['[See $](url)', '[A $]{.span}', '**$**', '_$_']) {
      const name = wrap.replace('$', ':badge[New]{v¦}');
      assert.strictEqual(await accept(name, 'variant', vscode.CompletionItemKind.Property), wrap.replace('$', ':badge[New]{variant=""}'));
      const value = wrap.replace('$', ':badge[New]{variant="s¦"}');
      assert.strictEqual(await accept(value, '"success"'), wrap.replace('$', ':badge[New]{variant="success"}'));
    }
  });

  suiteSetup(async function () {
    this.timeout(15000);
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'The test harness must open its isolated fixture workspace');
    metadataUri = vscode.Uri.file(folder.uri.fsPath + '/component-metadata.json');
    originalMetadata = await vscode.workspace.fs.readFile(metadataUri);
    const extension = vscode.extensions.getExtension('Nuxt.mdc');
    assert.ok(extension);
    await extension.activate();
    const config = vscode.workspace.getConfiguration('mdc');
    await config.update('componentMetadataLocalFilePattern', 'component-metadata.json', vscode.ConfigurationTarget.Workspace);
    await config.update('enableComponentMetadataCompletions', true, vscode.ConfigurationTarget.Workspace);

    // Activation and config.update do not await async metadata/provider registration.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const probe = await request('::card\n---\nvariant: ¦\n---\n::');
      if (values(probe.items).includes('"outline"')) { return; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('The registered provider did not become ready');
  });

  suiteTeardown(async () => {
    await vscode.workspace.fs.writeFile(metadataUri, originalMetadata);
    const config = vscode.workspace.getConfiguration('mdc');
    await config.update('enableComponentMetadataCompletions', undefined, vscode.ConfigurationTarget.Workspace);
    await config.update('componentMetadataLocalFilePattern', undefined, vscode.ConfigurationTarget.Workspace);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('offers structured schema literals on manual and colon triggers', async () => {
    for (const trigger of [undefined, ':', ' ', '"', "'"]) {
      const result = await request('::card\n---\nvariant: ¦\n---\n::', trigger);
      assert.deepStrictEqual(values(result.items), ['"default"', '"muted"', '"outline"']);
    }
  });

  test('preserves quotes, comments, mid-token edits, incomplete values, and cursor whitespace', async () => {
    const cases = [
      ['variant: o¦', 'variant: "outline"'],
      ['variant: "o¦" # note', 'variant: "outline" # note'],
      ["variant: 'o¦' # note", "variant: 'outline' # note"],
      ['variant: "o¦', 'variant: "outline"'],
      ['variant: "¦', 'variant: "outline"'],
      ["variant: '¦", "variant: 'outline'"],
      ["variant: 'o¦", "variant: 'outline'"],
      ['variant: "ou¦tline"', 'variant: "outline"'],
      ['variant: o  ¦', 'variant: "outline"'],
      ['variant: ¦  ', 'variant: "outline"'],
      ['variant:¦', 'variant: "outline"'],
    ];
    for (const [line, expected] of cases) {
      assert.strictEqual(await accept(`::card\n---\n${line}\n---\n::`, '"outline"'), `::card\n---\n${expected}\n---\n::`);
    }
  });

  test('completes both props-block forms and permits YAML to override inline attributes', async () => {
    for (const [open, close] of [['---', '---'], ['```yaml [props]', '```'], ['~~~~yaml [props]', '~~~~']]) {
      const source = `::card{variant="muted" title="<!-- literal"}\n${open}\nvariant: o¦\n${close}\n::`;
      assert.strictEqual(await accept(source, '"outline"'), source.replace('o¦', '"outline"'));
    }
  });

  test('uses the nested component scope and restores scope after matching colon counts', async () => {
    for (const marker of ['::', ':::', '::::']) {
      const result = await request(`::card\n${marker}alert\n---\nvariant: ¦\n---\n${marker}\n::`);
      assert.deepStrictEqual(values(result.items), ['"info"', '"warning"']);
      const sibling = await request(`::card\n${marker}alert\n${marker}\n::\n::card\n---\nvariant: ¦\n---\n::`);
      assert.deepStrictEqual(values(sibling.items), ['"default"', '"muted"', '"outline"']);
    }
  });

  test('keeps boolean, numeric, and string literals distinct', async () => {
    const source = (line: string) => `::card\n---\n${line}\n---\n::`;
    assert.deepStrictEqual(values((await request(source('enabled: ¦'))).items), ['false', 'true']);
    assert.deepStrictEqual(values((await request(source('count: ¦'))).items), ['1', '2', '3']);
    assert.strictEqual(await accept(source('enabled: "¦"'), 'true'), source('enabled: true'));
    assert.strictEqual(await accept(source("count: '¦'"), '2'), source('count: 2'));
    assert.strictEqual(await accept(source('string-boolean: ¦'), '"true"'), source('string-boolean: "true"'));
  });

  test('does not invent values for unrestricted, missing, or nested props', async () => {
    for (const component of ['card', 'missing']) {
      for (const prop of ['text', 'number', 'missing']) {
        assert.deepStrictEqual(values((await request(`::${component}\n---\n${prop}: ¦\n---\n::`)).items), []);
      }
    }
    assert.deepStrictEqual(values((await request('::card\n---\noptions:\n  variant: ¦\n---\n::')).items), []);
  });

  test('retains required labels, camel/kebab lookup and existing nested key suggestions', async () => {
    const names = await request('::card\n---\nvar¦\n---\n::');
    const variant = names.items.find(item => label(item) === 'variant');
    assert.ok(variant);
    assert.strictEqual((variant.label as unknown as { detail: string }).detail, ' (required)');
    for (const key of ['longVariant', 'long-variant']) {
      assert.deepStrictEqual(values((await request(`::card\n---\n${key}: ¦\n---\n::`)).items), ['"narrow"', '"wide"']);
    }
    const nested = await request('::card\n---\noptions:\n  si¦\n---\n::');
    assert.ok(nested.items.some(item => label(item) === 'size' && item.kind === vscode.CompletionItemKind.Property));
  });

  test('suppresses duplicate keys but preserves the value when editing the current key', async () => {
    const names = await request('::card\n---\nvariant: outline\n¦\n---\n::');
    assert.ok(!names.items.some(item => label(item) === 'variant'));
    assert.strictEqual(
      await accept('::card\n---\nvar¦iant: "outline" # note\n---\n::', 'variant', vscode.CompletionItemKind.Property),
      '::card\n---\nvariant: "outline" # note\n---\n::'
    );
    assert.strictEqual(
      await accept('::card\n---\nlong-var¦iant: "wide"\n---\n::', 'long-variant', vscode.CompletionItemKind.Property),
      '::card\n---\nlong-variant: "wide"\n---\n::'
    );
  });

  test('excludes document frontmatter, code samples, comments, prose, and YAML scalars', async () => {
    const cases = [
      '---\nvariant: ¦\n---',
      '```md\n::card\n---\nvariant: ¦\n---\n::\n```',
      '<!--\n::card\n---\nvariant: ¦\n---\n::\n-->',
      '::card\n```yaml\nvariant: ¦\n```\n::',
      '::card\nParagraph\n---\nvariant: ¦\n---\n::',
      '::card\n#footer\n```yaml [props]\nvariant: ¦\n```\n::',
      '::card\n---\ntext: |\n  variant: ¦\n---\n::',
      '::card\n---\ntext: "multiline\nvariant: ¦\nend"\n---\n::',
      '::card\n---\n# variant: ¦\n---\n::',
      '::card\n---\nvariant: outline # ¦\n---\n::',
    ];
    for (const content of cases) { assert.deepStrictEqual(values((await request(content)).items), [], content); }
  });

  test('completes block and inline property names with usable snippets', async () => {
    const cases = [
      ['::card{v¦}', 'variant', '::card{variant=""}'],
      [':::card{v¦}', 'variant', ':::card{variant=""}'],
      ['::::card{v¦', 'variant', '::::card{variant=""'],
      ['::card{¦', 'variant', '::card{variant=""'],
      ['Text :badge[New]{v¦}', 'variant', 'Text :badge[New]{variant=""}'],
      ['Text :tooltip{t¦}', 'text', 'Text :tooltip{text=""}'],
      ['Text :badge{variant="success"} and :tooltip{t¦}', 'text', 'Text :badge{variant="success"} and :tooltip{text=""}'],
      ['::card{en¦}', 'enabled', '::card{enabled}'],
      ['::card{co¦}', 'count', '::card{:count=""}'],
      ['::card{false-o¦}', 'false-only', '::card{:false-only=""}'],
      ['::card{:v¦}', 'variant', '::card{:variant=""}'],
      ['::card{variant="outline"¦}', 'title', '::card{variant="outline" title=""}'],
    ];
    for (const [source, name, expected] of cases) {
      assert.strictEqual(await accept(source, name, vscode.CompletionItemKind.Property), expected);
    }
  });

  test('re-triggers string choices at the inserted property snippet position', async () => {
    const result = await request('::card{v¦}');
    const variant = result.items.find(item => label(item) === 'variant')!;
    assert.ok(variant.insertText instanceof vscode.SnippetString);
    assert.ok(variant.range instanceof vscode.Range && variant.range.contains(result.position));
    assert.strictEqual(variant.command?.command, 'editor.action.triggerSuggest');
    assert.strictEqual((variant.label as unknown as { detail: string }).detail, ' (required)');
    const editor = await vscode.window.showTextDocument(result.document);
    await editor.insertSnippet(variant.insertText, variant.range);
    await vscode.commands.executeCommand(variant.command!.command);
    const choices = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', result.document.uri, editor.selection.active);
    assert.deepStrictEqual(values(choices?.items ?? []), ['"default"', '"muted"', '"outline"']);
    await vscode.commands.executeCommand('hideSuggestWidget');
  });

  test('inserts inline values without changing surrounding attributes or text', async () => {
    const cases = [
      ['::card{variant="o¦"}', '::card{variant="outline"}'],
      ["::card{variant='o¦'}", "::card{variant='outline'}"],
      ['::card{variant=o¦}', '::card{variant="outline"}'],
      ['::card{variant="o¦', '::card{variant="outline"'],
      ['::card{variant="¦}', '::card{variant="outline"}'],
      ["::card{variant='o¦}", "::card{variant='outline'}"],
      ['::card{variant="ou¦tline" title="Keep"} after', '::card{variant="outline" title="Keep"} after'],
      ['::card{variant=¦  }', '::card{variant="outline"}'],
      ['::card{variant=¦ title="Keep"}', '::card{variant="outline" title="Keep"}'],
      ['::card{variant= ¦ title="Keep"}', '::card{variant="outline" title="Keep"}'],
    ];
    for (const [source, expected] of cases) { assert.strictEqual(await accept(source, '"outline"'), expected); }
    assert.strictEqual(await accept('Text :badge[New]{variant="da¦"} after', '"danger"'), 'Text :badge[New]{variant="danger"} after');
    const badge = await request('Text :tooltip{text="Keep"} and :badge[New]{variant="¦"}');
    assert.deepStrictEqual(values(badge.items), ['"danger"', '"success"']);
    for (const trigger of ['{', '=', '"', "'"]) {
      assert.ok((await request('::card{variant="¦"}', trigger)).items.some(item => label(item) === '"outline"'));
    }
  });

  test('suppresses duplicate attributes but allows current-key edits and preserves bindings', async () => {
    for (const source of ['::card{variant="outline" ¦}', '::card{:variant="data.choice" ¦}', '::card{longVariant="wide" ¦}']) {
      const result = await request(source);
      const duplicate = source.includes('longVariant') ? 'long-variant' : 'variant';
      assert.ok(!result.items.some(item => label(item) === duplicate && item.kind === vscode.CompletionItemKind.Property));
    }
    assert.strictEqual(await accept('::card{long-var¦iant="wide" title="Keep"}', 'long-variant', vscode.CompletionItemKind.Property), '::card{long-variant="wide" title="Keep"}');
    assert.strictEqual(await accept('::card{:var¦iant="data.choice"}', 'variant', vscode.CompletionItemKind.Property), '::card{:variant="data.choice"}');
    assert.strictEqual(await accept(`::card{:options={text:'}'} v¦}`, 'variant', vscode.CompletionItemKind.Property), `::card{:options={text:'}'} variant=""}`);
    for (const source of ['::card{:variant="data.¦"}', '::card{:options={text:":badge{v¦}"}}', '::card{enabled="¦"}', '::card{count="¦"}', '::card{text="¦"}', '::unknown{variant="¦"}']) {
      assert.deepStrictEqual(values((await request(source)).items), []);
    }
  });

  test('inserts special string literals as plain text and omits lossy representations', async () => {
    const fixtures = JSON.parse(new TextDecoder().decode(originalMetadata));
    const special = fixtures[0].component_meta.meta.props.find((prop: { name: string }) => prop.name === 'special');
    const safe = special.schema.schema.slice(0, 5).map((literal: string) => JSON.parse(literal));
    const result = await request('::card{special="¦" title="Keep"}');
    assert.deepStrictEqual(values(result.items), safe.map((value: string) => JSON.stringify(value)).sort());
    for (const value of safe) {
      const quote = value.includes('"') ? "'" : '"';
      const output = await accept('::card{special="¦" title="Keep"}', JSON.stringify(value));
      assert.strictEqual(output, `::card{special=${quote}${value}${quote} title="Keep"}`);
    }
    assert.strictEqual(await accept("::card{special='¦'}", JSON.stringify("can't")), '::card{special="can\'t"}');
  });

  test('excludes native attributes, code, YAML, comments, escaped syntax and unrelated colons', async () => {
    const sources = [
      '[Span]{v¦}', '[Link](url){v¦}', '![Image](image.png){v¦}',
      '`::card{v¦}`', 'Text `code\n:badge[New]{v¦}\nend`',
      '```md\n::card{v¦}\n```', '<!-- ::card{v¦} -->', '<!--\n:badge{v¦}\n-->',
      '---\ntitle: :badge{v¦}\n---', '::card\n---\ntitle: :badge{v¦}\n---\n::',
      '::card\n```yaml [props]\ntitle: :badge{v¦}\n```\n::',
      String.raw`\::card{v¦}`, String.raw`Text \:badge{v¦}`, 'http://card{v¦}',
    ];
    for (const source of sources) {
      const result = await request(source);
      assert.ok(!result.items.some(item => item.kind === vscode.CompletionItemKind.Property || item.kind === vscode.CompletionItemKind.EnumMember), source);
    }
    const resumed = await request('Text `code\nend` :badge[New]{variant="¦"}');
    assert.deepStrictEqual(values(resumed.items), ['"danger"', '"success"']);
  });

  test('preserves existing component-name filtering and replacement behavior', async () => {
    const source = '::ca¦rd\n---\nvariant: outline\n---\n::';
    const result = await request(source);
    const card = result.items.find(item => label(item) === 'card' && item.kind === vscode.CompletionItemKind.Function)!;
    assert.ok(card);
    assert.ok(card.range instanceof vscode.Range && card.range.contains(result.position));
    const editor = await vscode.window.showTextDocument(result.document);
    assert.ok(card.insertText instanceof vscode.SnippetString);
    await editor.insertSnippet(card.insertText, card.range);
    assert.strictEqual(result.document.getText(), source.replace('¦', ''));
  });

  test('reads changed choices after the existing metadata refresh command', async () => {
    const metadata = JSON.parse(new TextDecoder().decode(originalMetadata));
    metadata[0].component_meta.meta.props[0].schema.schema = ['"new-choice"'];
    await vscode.workspace.fs.writeFile(metadataUri, new TextEncoder().encode(JSON.stringify(metadata)));
    try {
      await vscode.commands.executeCommand('mdc.refreshMetadata');
      assert.deepStrictEqual(values((await request('::card\n---\nvariant: ¦\n---\n::')).items), ['"new-choice"']);
    } finally {
      await vscode.workspace.fs.writeFile(metadataUri, originalMetadata);
      await vscode.commands.executeCommand('mdc.refreshMetadata');
    }
  });
});
