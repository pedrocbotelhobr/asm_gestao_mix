import * as pdfjs from './vendor/pdf.min.mjs';
import { lerTabela, linhasDoPdf, lerPedidos, conferir, mensagem, rotuloLoja, brl, qtd } from './conferencia.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;

const $ = id => document.getElementById(id);
let tabela = null, pedidosPdf = [], res = null, marcados = new Set();

const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt !== undefined) e.textContent = txt; return e; };
const estado = (t, erro = false) => { $('estado').textContent = t; $('estado').className = 'estado' + (erro ? ' erro' : ''); };

async function linhasDaPlanilha(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const erros = [];
  for (const ws of wb.worksheets) {
    const rows = [];
    ws.eachRow({ includeEmpty: true }, r => rows.push(r.values.slice(1).map(v => (v && typeof v === 'object') ? (v.result ?? v.text ?? (v.richText ? v.richText.map(x => x.text).join('') : '')) : v)));
    try { return lerTabela(rows); } catch (e) { erros.push(e); }
  }
  throw erros[0] || new Error('Planilha vazia.');
}

$('tabela').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  $('caixaTabela').classList.remove('pronto'); tabela = null; res = null; $('resultado').hidden = true;
  estado('Lendo a tabela...');
  try {
    tabela = await linhasDaPlanilha(f);
    $('nomeTabela').textContent = `${f.name}: ${tabela.size} produtos`;
    $('caixaTabela').classList.add('pronto');
    estado(''); rodar();
  } catch (err) { estado(`Não consegui ler a tabela. ${err.message}`, true); }
});

$('pedido').addEventListener('change', async e => {
  const fs = [...e.target.files]; if (!fs.length) return;
  $('caixaPedido').classList.remove('pronto'); pedidosPdf = []; res = null; $('resultado').hidden = true;
  estado('Lendo o PDF...');
  try {
    for (const f of fs) {
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await f.arrayBuffer()) }).promise;
      pedidosPdf.push({ nome: f.name, paginas: await linhasDoPdf(pdfjs, doc) });
    }
    $('nomePedido').textContent = fs.map(f => f.name).join(', ');
    $('caixaPedido').classList.add('pronto');
    estado(''); rodar();
  } catch (err) { estado(`Não consegui abrir o PDF. ${err.message}`, true); }
});

function rodar() {
  if (!tabela) { if (pedidosPdf.length) estado('Falta a tabela de preços.'); return; }
  if (!pedidosPdf.length) { estado('Falta o pedido do cliente.'); return; }
  const semTexto = pedidosPdf.filter(p => !p.paginas.some(l => l.length));
  if (semTexto.length) return estado(`${semTexto[0].nome} é um PDF de imagem, sem texto para ler. Peça o PDF original ao cliente.`, true);
  const pedidos = pedidosPdf.flatMap(p => lerPedidos(p.paginas, tabela).pedidos);
  if (!pedidos.some(p => p.itens.length)) return estado('Não reconheci itens neste layout de PDF. Confira este pedido manualmente e envie o arquivo para incluirmos o formato.', true);
  res = conferir(pedidos, tabela);
  marcados = new Set(res.lojas.flatMap(l => l.pedidos.flatMap(p => p.ajustes.filter(a => a.marcado).map(a => a.id))));
  desenhar();
  atualizarMensagem();
  $('resultado').hidden = false;
}

function desenhar() {
  const peds = res.lojas.flatMap(l => l.pedidos);
  const nAj = peds.flatMap(p => p.ajustes).length;
  const nCh = peds.flatMap(p => p.checar).length;
  const nTotalRuim = peds.filter(p => p.totalOk === false || !p.itens.length).length;
  const semTotal = peds.filter(p => p.totalOk === null && p.itens.length).length;
  const r = $('resumo'); r.replaceChildren();
  const add = (n, t, ruim) => { const d = el('div', ruim ? 'ruim' : ''); d.append(el('dd', '', n), el('dt', '', t)); r.append(d); };
  add(res.lojas.length, res.lojas.length === 1 ? 'loja' : 'lojas');
  add(peds.length, peds.length === 1 ? 'pedido' : 'pedidos');
  add(res.nItens, 'itens');
  add(nAj, nAj === 1 ? 'ajuste' : 'ajustes');
  add(nCh, 'para checar', nCh > 0);
  if (nTotalRuim) estado(`Atenção: em ${nTotalRuim} pedido(s), a soma dos itens lidos não bate com o total impresso. Pode faltar item.`, true);
  else if (semTotal) estado(`${semTotal} pedido(s) sem total impresso reconhecido. Confira se todos os itens apareceram.`);
  else estado(`Leitura conferida: a soma dos itens bate com o total dos ${peds.length} pedido(s).`);

  const box = $('lojas'); box.replaceChildren();
  res.lojas.forEach((l, i) => {
    const n = l.pedidos.flatMap(p => p.ajustes).length, c = l.pedidos.flatMap(p => p.checar).length;
    const d = el('details', 'loja'); if (res.lojas.length === 1 || i === 0) d.open = true;
    const s = el('summary'); const h = el('h3', '', l.nome);
    h.append(el('span', 'sub', [rotuloLoja(l), l.cnpj].filter(Boolean).join(' | ')));
    s.append(h, el('span', 'contagem' + (n || c ? '' : ' zero'), n || c ? `${n} ajuste${n === 1 ? '' : 's'}${c ? `, ${c} a checar` : ''}` : 'ok'));
    d.append(s);
    const corpo = el('div', 'corpo');
    if (n) { const b = el('button', 'acao-loja', 'Copiar só esta loja'); b.type = 'button'; b.addEventListener('click', () => copiar(mensagem(res.lojas, marcados, l), b)); corpo.append(b); }
    for (const p of l.pedidos) {
      const box = el('div', 'pedido');
      const t = el('div', 'pedido-topo');
      t.append(el('strong', '', `Pedido ${p.numero ?? 'sem número'}`));
      if (p.total !== null) t.append(el('span', '', brl(p.total)));
      if (p.prazo !== null) t.append(el('span', '', `prazo ${p.prazo}d`));
      t.append(el('span', '', `${p.itens.length} ${p.itens.length === 1 ? "item" : "itens"}`));
      box.append(t);
      for (const a of p.ajustes) box.append(linhaAjuste(a));
      if (!p.ajustes.length && !p.checar.length) box.append(el('p', 'semajuste', 'Sem ajustes.'));
      if (p.checar.length) { const u = el('ul', 'checar'); p.checar.forEach(c => u.append(el('li', '', c.texto))); box.append(u); }
      corpo.append(box);
    }
    d.append(corpo); box.append(d);
  });
}

function linhaAjuste(a) {
  const lb = el('label', 'ajuste' + (marcados.has(a.id) ? '' : ' desmarcado'));
  const c = el('input'); c.type = 'checkbox'; c.checked = marcados.has(a.id);
  c.addEventListener('change', () => { c.checked ? marcados.add(a.id) : marcados.delete(a.id); lb.classList.toggle('desmarcado', !c.checked); atualizarMensagem(); });
  const prod = el('span', 'prod'); prod.append(el('span', 'cod', a.sku), ` ${a.produto}`);
  const u = (a.un || '').toLowerCase();
  const val = el('span', 'valor');
  if (a.tipo === 'preco') { val.append(`${brl(a.de)} para `, el('b', '', brl(a.para))); }
  else { val.append(`${qtd(a.de)} para `, el('b', '', `${qtd(a.para)} ${u}`)); }
  lb.append(c, prod, val);
  if (a.tipo === 'qtd') lb.append(el('span', 'aviso', `Embalagem ${a.embalagem}: múltiplo de ${qtd(a.multiplo)} ${u}`));
  if (a.aviso) lb.append(el('span', 'aviso', a.aviso));
  return lb;
}

function atualizarMensagem() { $('mensagem').textContent = mensagem(res.lojas, marcados); }

async function copiar(texto, botao) {
  const orig = botao.textContent;
  try { await navigator.clipboard.writeText(texto); botao.textContent = 'Copiada'; }
  catch { const t = el('textarea'); t.value = texto; document.body.append(t); t.select(); document.execCommand('copy'); t.remove(); botao.textContent = 'Copiada'; }
  setTimeout(() => { botao.textContent = orig; }, 1800);
}
$('copiar').addEventListener('click', e => copiar($('mensagem').textContent, e.currentTarget));

// Exemplo fictício para a página não abrir vazia.
function exemplo() {
  tabela = lerTabela([['SKU', 'Descrição', 'Unidade', 'Embalagem', 'Preço'],
    ['000001', 'PRODUTO EXEMPLO A KG', 'KG', '5/5', 12.9], ['000002', 'PRODUTO EXEMPLO B KG', 'KG', '10/10', 30], ['000003', 'PRODUTO EXEMPLO C KG', 'KG', '25/5', 8.5]]);
  const pag = [[
    'PEDIDO DE COMPRAS   1001/ L',
    'R. Social   NOVA GERACAO   CASAS PEDRO   R. Social   MERCADO FICTICIO LTDA   LOJA EXEMPLO CENTRO',
    '000001   10   PRODUTO EXEMPLO A   KG 1   10,00   11,9000   119,00   119,00',
    '000002   11   PRODUTO EXEMPLO B   KG 1   15,00   30,0000   450,00   450,00',
    '000003   12   PRODUTO EXEMPLO C   KG 1   5,00   8,5000   42,50   42,50',
    'Valor total do pedido   611,50',
  ]];
  res = conferir(lerPedidos(pag, tabela).pedidos, tabela);
  marcados = new Set(res.lojas.flatMap(l => l.pedidos.flatMap(p => p.ajustes.map(a => a.id))));
  desenhar(); atualizarMensagem(); $('resultado').hidden = false;
  estado('Exemplo fictício. Escolha a sua tabela e o PDF do pedido para fazer a conferência real.');
  tabela = null;
}
exemplo();
