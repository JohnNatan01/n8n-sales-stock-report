// Tests the exported workflows without an n8n instance:
//  - structure: connections and $('Node') references point to real nodes
//  - behaviour: the JavaScript inside the Code nodes, run against fixtures
// Run with: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKFLOWS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'workflows');
const files = fs.readdirSync(WORKFLOWS).filter(f => f.endsWith('.json'));
const load = file => JSON.parse(fs.readFileSync(path.join(WORKFLOWS, file), 'utf8'));
const codeOf = (file, nodeName) => {
  const node = load(file).nodes.find(n => n.name === nodeName);
  assert.ok(node, `${file}: node "${nodeName}" not found`);
  return node.parameters.jsCode;
};

// Minimal stand-in for the n8n Code node runtime ($, $input).
function runCode(jsCode, nodes = {}, input = []) {
  const $ = name => {
    if (!(name in nodes)) throw new Error(`node "${name}" not provided`);
    const items = nodes[name].map(json => ({ json }));
    return { all: () => items, first: () => items[0] };
  };
  const $input = { all: () => input.map(json => ({ json })), first: () => ({ json: input[0] }) };
  return new Function('$', '$input', 'Buffer', jsCode)($, $input, Buffer);
}

// ------------------------------------------------------------------ structure
for (const file of files) {
  test(`${file}: is a valid, self-consistent n8n workflow`, () => {
    const wf = load(file);
    const names = new Set(wf.nodes.map(n => n.name));
    assert.equal(names.size, wf.nodes.length, 'node names must be unique');
    assert.equal(wf.active, false, 'exported workflows must be inactive');

    const incoming = new Set();
    for (const [from, { main }] of Object.entries(wf.connections)) {
      assert.ok(names.has(from), `connection from unknown node "${from}"`);
      for (const target of main.flat()) {
        assert.ok(names.has(target.node), `connection to unknown node "${target.node}"`);
        incoming.add(target.node);
      }
    }

    const strings = [];
    const walk = v => (typeof v === 'string' ? strings.push(v) : v && typeof v === 'object' && Object.values(v).forEach(walk));
    walk(wf.nodes.map(n => n.parameters));
    for (const [, ref] of strings.join('\n').matchAll(/\$\(["']([^"']+)["']\)/g)) {
      assert.ok(names.has(ref), `expression references unknown node "${ref}"`);
    }

    for (const n of wf.nodes) {
      const isEntry = /Trigger|stickyNote/i.test(n.type);
      assert.ok(isEntry || incoming.has(n.name), `node "${n.name}" is not connected`);
    }
  });
}

// ------------------------------------------------------------------ 04 consolidate
const base = [
  { 'Cod Componente': 'CP350', Descricao: 'Copo 350ml', 'Cod Cx': 'CP350-CX24', 'Cod Jg': 'CP350-JG6', 'Cod Composicao': 'KIT-BAR', 'Qtd Cx': '24', 'Qtd Jg': '6', 'Qtd Comp': '4' },
  { 'Cod Componente': 'PR27', Descricao: 'Prato 27cm', 'Cod Dec': 'PR27-DEC', 'Qtd Cx': '12' },
];
const consolidate = (sales, stock = [{ Codigo: 'CP350', Quantidade: '0' }]) => {
  const rows = runCode(codeOf('04-consolidate-report.json', 'Convert to Units & Aggregate'), {
    'Read Base': base,
    'Read Stock': stock,
    'Read Sales - Store A': sales,
    'Read Sales - Store B': [{}],
    'Read Sales - Store C': [{}],
  });
  return Object.fromEntries(rows.map(r => [r.json['Cod Componente'], r.json]));
};

test('04: boxes, sets and kits are converted to units', () => {
  const r = consolidate([
    { Codigo: 'CP350-CX24', Qtde: '2' },  // 2 boxes x 24
    { Codigo: 'CP350-JG6', Qtde: '3' },   // 3 sets  x 6
    { Codigo: 'KIT-BAR', Qtde: '5' },     // 5 kits  x 4
    { Codigo: 'CP350', Qtde: '7' },       // 7 units
  ]).CP350;
  assert.deepEqual([r.Cx, r.Jg, r.Comp, r.Un, r.Total], [48, 18, 20, 7, 93]);
  assert.equal(r['Media M'], 31); // ceil(93 / 3)
});

test('04: online sales are counted when numeroLoja is present', () => {
  const r = consolidate([
    { Codigo: 'CP350', Qtde: '4', numeroLoja: 'MKT-1' },
    { Codigo: 'CP350', Qtde: '6' },
  ]).CP350;
  assert.equal(r.On, 4);
  assert.equal(r.Total, 10);
});

test('04: Brazilian number format is parsed', () => {
  assert.equal(consolidate([{ Codigo: 'CP350', Qtde: '1.234,5' }]).CP350.Un, 1234.5);
});

test('04: decorated variants roll up into the base component', () => {
  const r = consolidate([{ Codigo: 'PR27-DEC', Qtde: '3' }]).PR27;
  assert.equal(r.Dec, 3);
  assert.equal(r['Encontrado na Base'], 'Sim');
});

test('04: stock converts sets to units and flags codes missing from the Base', () => {
  const r = consolidate([{ Codigo: 'CP350', Qtde: '1' }], [
    { Codigo: 'CP350', Quantidade: '10' },
    { Codigo: 'CP350-JG6', Quantidade: '2' },
    { Codigo: 'NEW-01', Quantidade: '3', itensPorCaixa: '4' },
  ]);
  assert.deepEqual([r.CP350['Qtd Estoque Jg'], r.CP350['Qtd Estoque CX_UN'], r.CP350['Total Estoque']], [12, 10, 22]);
  assert.equal(r['NEW-01']['Total Estoque'], 12);
  assert.equal(r['NEW-01']['Encontrado na Base'], 'Nao');
});

// ------------------------------------------------------------------ 02 sales
test('02: order IDs page is flagged as "has more" only when full', () => {
  const code = codeOf('02a-sales-sync-store-a.json', 'Extract Order IDs');
  const page = (ids, pageSize = 2) => runCode(code, { 'Set Page': [{ pagina: 1, pageSize }] }, [{ data: ids.map(id => ({ id })) }]);
  assert.equal(page([1, 2])[0].json.hasMorePages, true);
  assert.equal(page([1])[0].json.hasMorePages, false);
  assert.equal(page([])[0].json.id, null);
});

test('02: freight and discounts are prorated by the item share of the order', () => {
  const [row] = runCode(codeOf('02a-sales-sync-store-a.json', 'Build Sales Rows'), {}, [{
    data: { id: 1, data: '2026-01-10', totalProdutos: 100, transporte: { frete: 10 }, desconto: { valor: 20 }, outrasDespesas: 4, itens: [{}, {}] },
    'data.itens': { id: 11, codigo: 'CP350', descricao: 'Copo', quantidade: 3, valor: 25, desconto: 1, produto: { id: 9 } },
  }]);
  // item = 75% of the order
  assert.equal(row.json.Valor, 75);
  assert.equal(row.json.Frete, 7.5);
  assert.equal(row.json.Desconto, 16);
  assert.equal(row.json['Outras despesas'], 3);
  assert.equal(row.json['Total Venda'], 75 + 7.5 - 15 + 3);
});

test('02: the three store workflows share the same logic', () => {
  // Compare parameters only, ignoring what legitimately differs per store:
  // spreadsheet, tab and the random ids n8n gives to assignments/conditions.
  const ignore = new Set(['id', 'documentId', 'sheetName']);
  const strip = file => JSON.stringify(
    load(file).nodes.filter(n => n.type !== 'n8n-nodes-base.stickyNote').map(n => n.parameters),
    (key, value) => (ignore.has(key) ? undefined : value),
  );
  const a = strip('02a-sales-sync-store-a.json');
  assert.equal(strip('02b-sales-sync-store-b.json'), a);
  assert.equal(strip('02c-sales-sync-store-c.json'), a);
});

// ------------------------------------------------------------------ 05 send
test('05: CSV is Excel-friendly (BOM, ";" separator, quoted and escaped)', () => {
  const [out] = runCode(codeOf('05-send-report.json', 'Build CSV'), {}, [{ a: 'x;"y"', b: 'multi\nline' }]);
  const csv = Buffer.from(out.binary.data.data, 'base64').toString('utf8');
  assert.equal(csv, '﻿"a";"b"\n"x;""y""";"multi line"');
  assert.match(out.json.arquivo, /^relatorio_consolidado_\d{2}\.\d{2}_\d{2}\.\d{2}\.\d{4}\.csv$/);
});

// ------------------------------------------------------------------ 00 base
test('00: supplier base and composition structure are joined on the unit code', () => {
  const rows = runCode(codeOf('00-build-product-base.json', 'Join Base + Structure'), {
    'Read Supplier Base': [{ 'Cod Simp': 'S1', 'Cod Un': 'CP350', 'Cod Cx': 'CP350-CX24', 'Cod Dec': '', 'Cod Jg': 'CP350-JG6', Descricao: 'Copo', 'Qtde Cx': '24', 'Qtde Jg': '6' }],
    'Read Composition Structure': [{ 'Codigo da composicao': 'KIT-BAR', 'Codigo do componente': 'CP350', 'Quantidade do Componente': '4' }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].json['Cod Componente'], 'CP350');
  assert.equal(rows[0].json['Cod Composicao'], 'KIT-BAR');
  assert.equal(rows[0].json['Qtd Comp'], '4');
});
