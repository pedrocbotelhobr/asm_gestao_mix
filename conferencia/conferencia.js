// Lógica de conferência. Roda só no navegador: nenhum arquivo é enviado a servidor.
export const CNPJ_RAIZ_FORNECEDOR = '13594751'; // Nova Geração Comestíveis (Casas Pedro)

const semAcento = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const norm = s => semAcento(s).toUpperCase().trim();
export const num = s => parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
export const r2 = x => Math.round((x + 1e-9) * 100) / 100;
export const brl = x => 'R$ ' + r2(x).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const qtd = x => (Math.round(x * 1000) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 3 });

// ---------- Tabela de preços ----------
// rows: matriz de valores da planilha. Procura a linha de cabeçalho pelo nome das colunas.
export function lerTabela(rows) {
  const achar = (cab, ...nomes) => cab.findIndex(c => nomes.some(n => norm(c).startsWith(n)));
  for (let h = 0; h < Math.min(rows.length, 40); h++) {
    const cab = rows[h] || [];
    const c = {
      sku: achar(cab, 'SKU', 'COD'),
      desc: achar(cab, 'DESCRI', 'PRODUTO'),
      un: achar(cab, 'UNIDADE', 'UN'),
      emb: achar(cab, 'EMBALAGEM', 'EMB'),
      preco: achar(cab, 'PRECO', 'VALOR'),
    };
    if (c.sku < 0 || c.emb < 0 || c.preco < 0) continue;
    const produtos = new Map();
    for (const row of rows.slice(h + 1)) {
      const bruto = row[c.sku];
      if (bruto === null || bruto === undefined || bruto === '') continue;
      const sku = String(bruto).trim();
      if (!/^\d+$/.test(sku)) continue;
      const preco = typeof row[c.preco] === 'number' ? row[c.preco] : num(row[c.preco]);
      if (!Number.isFinite(preco)) continue;
      const codigo = sku.padStart(6, '0');
      produtos.set(codigo, {
        sku: codigo, desc: String(row[c.desc] ?? '').trim(), un: norm(row[c.un]),
        embalagem: String(row[c.emb] ?? '').trim(), multiplo: multiploDaEmbalagem(row[c.emb]), preco,
      });
    }
    if (produtos.size) return produtos;
  }
  throw new Error('Não encontrei as colunas SKU, Embalagem e Preço na planilha.');
}

// "5/5" = 5, "25/5" = 5, "1/20" = 1, 2.5 = 2,5. Em embalagem dupla, vale o menor número.
export function multiploDaEmbalagem(emb) {
  if (emb === null || emb === undefined || emb === '') return null;
  const nums = String(emb).split('/').map(x => parseFloat(x.trim().replace(',', '.'))).filter(x => x > 0);
  return nums.length ? Math.min(...nums) : null;
}

// ---------- PDF para linhas ----------
export async function linhasDoPdf(pdfjs, doc) {
  const paginas = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const pagina = await doc.getPage(n);
    const vp = pagina.getViewport({ scale: 1 });
    const { items } = await pagina.getTextContent();
    const pedacos = items.filter(i => i.str && i.str.trim()).map(i => {
      const t = pdfjs.Util.transform(vp.transform, i.transform);
      return { x: t[4], y: t[5], fim: t[4] + i.width, s: i.str };
    }).sort((a, b) => a.y - b.y || a.x - b.x);
    const linhas = [];
    for (const p of pedacos) {
      const l = linhas.find(l => Math.abs(l.y - p.y) < 2.5);
      if (l) l.p.push(p); else linhas.push({ y: p.y, p: [p] });
    }
    linhas.sort((a, b) => a.y - b.y);
    paginas.push(linhas.map(l => {
      l.p.sort((a, b) => a.x - b.x);
      let txt = '', fim = null;
      for (const p of l.p) {
        if (fim !== null) { const gap = p.x - fim; txt += gap > 7 ? '   ' : gap > 0.8 ? ' ' : ''; }
        txt += p.s; fim = Math.max(fim ?? 0, p.fim);
      }
      return txt.trim();
    }));
  }
  return paginas;
}

// ---------- Leitura dos pedidos ----------
const RE_NUM = /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+,\d+/g;
const TEM_NUM = /\d,\d/;
const RE_CNPJ = /\d{2}\.?\d{3}\.?\d{3}\s*\/\s*\d{4}\s*-?\s*\d{2}/g;
const IGNORAR = /TOTA[IL]|PESO|VOLUME|CNPJ|TAXA|DESCONTO|CEP\b/i;
const UNIDADES = 'KG|UN|UND|CX|PC|PCT|FD|SC|LT|DP|BD|FR|GR|G';

function achaTripla(linha, tabelaPreco) {
  // qtde x unitário = total, em qualquer layout. Inteiro seguido de unidade também vale como quantidade.
  let toks = [...linha.matchAll(RE_NUM)].map(m => ({ i: m.index, s: m[0], v: num(m[0]) }));
  const inteiros = [...linha.matchAll(new RegExp(`(?<![\\d.,/])(\\d{1,5})\\s*(?:${UNIDADES})\\b`, 'g'))]
    .map(m => ({ i: m.index, s: m[1], v: +m[1], inteiro: true }));
  toks = [...toks, ...inteiros].sort((a, b) => a.i - b.i);
  for (let a = 0; a < toks.length; a++) for (let b = a + 1; b < toks.length; b++) for (let c = b + 1; c < toks.length; c++) {
    const [q, p, v] = [toks[a], toks[b], toks[c]];
    if (!(q.v > 0 && p.v > 0 && v.v > 0)) continue;
    if (Math.abs(q.v * p.v - v.v) <= 0.02 + q.v * 0.00006) return { q, p, v };
  }
  return null;
}

const palavras = s => norm(s).replace(/\bS\//g, 'SEM ').replace(/\bC\//g, 'COM ').replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !['KG', 'DE', 'DO', 'DA', 'REF', 'EM', 'GRANEL'].includes(w) && !/^\d+$/.test(w));
export function parecido(a, b) {
  const A = palavras(a), B = palavras(b);
  if (!A.length || !B.length) return 0;
  const bate = A.filter(x => B.some(y => y === x || (x.length >= 4 && y.startsWith(x)) || (y.length >= 4 && x.startsWith(y)))).length;
  return bate / A.length;
}
// Sugestão só quando os dois nomes se parecem nos dois sentidos e não se contradizem (com x sem).
function melhorSugestao(desc, tabela) {
  const A = palavras(desc);
  let melhor = null, nota = 0;
  for (const t of tabela.values()) {
    const B = palavras(t.desc);
    if ((A.includes('COM') && B.includes('SEM')) || (A.includes('SEM') && B.includes('COM'))) continue;
    const ida = parecido(desc, t.desc), volta = parecido(t.desc, desc);
    if (Math.min(ida, volta) < 0.5) continue;
    const s = ida + volta;
    if (s > nota) { nota = s; melhor = t; }
  }
  return melhor;
}

function resolveCodigo(tok, tabela) {
  if (!/^\d{4,7}$/.test(tok)) return null;
  if (tabela.has(tok)) return tok;
  if (tok.length === 7 && tok[0] === '9' && tabela.has(tok.slice(1))) return tok.slice(1);
  const p = tok.padStart(6, '0');
  return tabela.has(p) ? p : null;
}

export function lerPedidos(paginas, tabela) {
  const pedidos = new Map();
  let atual = null, ultimoItem = null, semNumero = 0;
  const abrir = n => {
    const chave = n ?? `sem-numero-${++semNumero}`;
    if (!pedidos.has(chave)) pedidos.set(chave, { numero: n, itens: [], total: null, loja: null, cnpj: null, razao: null, bairro: null, cidade: null, prazo: null, emissao: null });
    atual = pedidos.get(chave); ultimoItem = null;
  };
  let semTexto = true;
  for (const linhas of paginas) {
    if (linhas.length) semTexto = false;
    const texto = linhas.join('\n');
    const mNum = texto.match(/PEDIDO DE COMPRAS?\s+(\d[\d.\-]*)/i) || texto.match(/(?:PEDIDO|ORDEM DE COMPRA)\s*(?:N[º°O.]*)?\s*[:#]\s*(\d[\d.\-]*)/i);
    if (mNum) abrir(mNum[1].replace(/[.\-]$/, ''));
    else if (!atual) abrir(null);
    const o = atual;
    const cnpjs = [...texto.matchAll(RE_CNPJ)].map(m => m[0].replace(/\s/g, '')).filter(c => !c.replace(/\D/g, '').startsWith(CNPJ_RAIZ_FORNECEDOR));
    if (!o.cnpj && cnpjs[0]) o.cnpj = cnpjs[0];
    let mTotal = texto.match(/VALOR TOTAL DO PEDIDO\s*:?\s*(?:R\$\s*)?([\d.,]+)/i);
    if (mTotal) o.total = num(mTotal[1]);
    const mPrazo = texto.match(/PRAZO PARA PAGAMENTO\s*:?\s*(\d+)/i); if (mPrazo) o.prazo = +mPrazo[1];
    const mData = texto.match(/DATA DA EMISS[AÃ]O\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i) || texto.match(/\bDATA\b\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i); if (mData && !o.emissao) o.emissao = mData[1];

    for (const linha of linhas) {
      const rs = [...linha.matchAll(/R\. ?SOCIAL/gi)];
      if (rs.length && !o.loja) {
        const trecho = linha.slice(rs[rs.length - 1].index).replace(/R\. ?SOCIAL\s*/i, '');
        const partes = trecho.split(/\s{3,}/).map(s => s.trim()).filter(Boolean);
        if (rs.length > 1 || !/NOVA GERACAO/i.test(trecho)) { o.razao = partes[0] || null; o.loja = partes[1] || partes[0] || null; }
      }
      if (!o.bairro) { const m = linha.match(/BAIRRO\s+.*\sBAIRRO\s+(.+)$/i); if (m) o.bairro = m[1].split(/\s{3,}/)[0].trim(); }
      if (!o.cidade) { const m = [...linha.matchAll(/CIDADE\s+(.+?)\s+CNPJ/gi)]; if (m.length > 1) o.cidade = m[1][1].trim(); }
      if (!o.loja) { const m = linha.match(/^\s*(?:CLIENTE|LOJA|FILIAL|DESTINAT[AÁ]RIO)\s*:?\s+(.{3,}?)(?:\s{3,}|\s+-\s+\d{2}\.\d{3}|$)/i); if (m) o.loja = m[1].trim(); }
      if (o.total === null) { const m = linha.match(/^\s*TOTAL(?: DO PEDIDO| GERAL)?\s*:?\s*R\$\s*([\d.,]+)/i) || linha.match(/\bTOTAL\s+R\$\s*([\d.,]+)/i); if (m) o.total = num(m[1]); }

      const tr = IGNORAR.test(linha) ? null : achaTripla(linha);
      if (tr) {
        const prefixo = linha.slice(0, tr.q.i).trim();
        const toksP = prefixo.split(/\s+/);
        let cod = resolveCodigo(toksP[0], tabela);
        const brutoCod = /^\d/.test(toksP[0]) ? (prefixo.match(/^\d+(?:\s*\/\s*[A-Z])?/)?.[0] ?? toksP[0]) : '';
        const mUn = prefixo.match(new RegExp(`\\b(${UNIDADES})\\s*(\\d+)?\\s*$`));
        const desc = prefixo.replace(/^\d+(?:\s*\/\s*[A-Z])?\s*/, '').replace(/^\d+\s+/, '').replace(new RegExp(`\\s*\\b(${UNIDADES})\\s*\\d*\\s*$`), '').trim();
        // Se a linha trouxer o preço antes da quantidade, inverte quando R$ ou 4 casas denunciarem.
        let { q, p } = tr;
        const antes = linha.slice(Math.max(0, q.i - 4), q.i);
        if (/R\$\s*$/.test(antes) && !/R\$\s*$/.test(linha.slice(Math.max(0, p.i - 4), p.i))) [q, p] = [p, q];
        ultimoItem = { pedido: o.numero, brutoCod, cod, desc, q: q.v, p: p.v, v: tr.v.v, un: mUn ? mUn[1] : null, fator: mUn && mUn[2] && mUn[2].length <= 3 ? +mUn[2] : 1 };
        o.itens.push(ultimoItem);
      } else if (ultimoItem) {
        const ref = linha.match(/REF\s*:?\s*(\d{4,7})\s*$/i);
        if (ref && !ultimoItem.cod) ultimoItem.cod = resolveCodigo(ref[1], tabela);
        if (/^\s*EANS?\s*:/i.test(linha)) { const e = linha.match(/\d{8,14}/); if (e) ultimoItem.ean = e[0]; ultimoItem = null; }
        else if (!TEM_NUM.test(linha) && linha.length < 40 && !/^(DADOS|TOTAIS|TOTVS)/i.test(linha)) ultimoItem.desc = (ultimoItem.desc + ' ' + linha.replace(/-?\s*REF\s*:?.*$/i, '').trim()).trim();
        else ultimoItem = null;
      }
    }
  }
  return { pedidos: [...pedidos.values()], semTexto };
}

// ---------- Comparação ----------
export function conferir(pedidos, tabela) {
  const lojas = new Map();
  let nItens = 0;
  for (const o of pedidos) {
    const chave = (o.cnpj || o.loja || 'sem-loja');
    if (!lojas.has(chave)) lojas.set(chave, { chave, nome: o.loja || 'Loja não identificada', razao: o.razao, cnpj: o.cnpj, bairro: o.bairro, cidade: o.cidade, pedidos: [] });
    const conf = { ...o, ajustes: [], checar: [], soma: 0, totalOk: null };
    lojas.get(chave).pedidos.push(conf);
    for (const it of o.itens) {
      nItens++;
      conf.soma = r2(conf.soma + it.v);
      const tb = it.cod ? tabela.get(it.cod) : null;
      if (!tb) {
        const melhor = melhorSugestao(it.desc, tabela);
        conf.checar.push({ tipo: 'nao-encontrado', it, sugestao: melhor,
          texto: `${it.brutoCod || 'sem código'} ${it.desc}: código não está na tabela${melhor ? `. Talvez seja ${melhor.sku} ${melhor.desc}` : ''}.` });
        continue;
      }
      const unDif = !!(it.un && tb.un && it.un !== tb.un);
      if (palavras(it.desc).length >= 2 && parecido(it.desc, tb.desc) === 0) conf.checar.push({ tipo: 'descricao', it, texto: `${tb.sku}: o pedido diz "${it.desc}" e a tabela diz "${tb.desc}".` });
      if (it.fator > 1) conf.checar.push({ tipo: 'fator', it, texto: `${tb.sku} ${tb.desc}: pedido em ${it.un} ${it.fator}. Confira a quantidade em ${tb.un}.` });
      if (unDif) conf.checar.push({ tipo: 'unidade', it, texto: `${tb.sku} ${tb.desc}: pedido em ${it.un} e tabela em ${tb.un}. Não marquei ajuste automático.` });

      const pTab = r2(tb.preco), pPed = r2(it.p);
      if (Math.abs(pTab - pPed) >= 0.005) {
        conf.ajustes.push({ id: `${o.numero}|${tb.sku}|preco`, tipo: 'preco', sku: tb.sku, produto: tb.desc, un: tb.un, de: pPed, para: pTab, marcado: !unDif,
          aviso: unDif ? `Pedido em ${it.un}, tabela em ${tb.un}` : null });
      }
      if (tb.multiplo && it.fator === 1) {
        const n = it.q / tb.multiplo;
        if (Math.abs(n - Math.round(n)) > 1e-6) {
          const para = Math.round(Math.ceil(n - 1e-6) * tb.multiplo * 1000) / 1000;
          conf.ajustes.push({ id: `${o.numero}|${tb.sku}|qtd`, tipo: 'qtd', sku: tb.sku, produto: tb.desc, un: tb.un, de: it.q, para, multiplo: tb.multiplo, embalagem: tb.embalagem, marcado: !unDif,
            aviso: unDif ? `Pedido em ${it.un}, tabela em ${tb.un}` : null });
        }
      }
    }
    if (o.total !== null) conf.totalOk = Math.abs(conf.soma - o.total) <= 0.02;
    if (conf.totalOk === false) conf.checar.unshift({ tipo: 'leitura', texto: `Li ${brl(conf.soma)} em itens, mas o total impresso é ${brl(o.total)}. Pode faltar item nesta conferência.` });
    if (!o.itens.length) conf.checar.unshift({ tipo: 'leitura', texto: 'Nenhum item lido neste pedido.' });
  }
  return { lojas: [...lojas.values()], nItens };
}

// ---------- Mensagem ----------
const un = a => (a.un || '').toLowerCase();
const nomeProduto = s => s.replace(/\s+/g, ' ').trim();
const SEP = '━━━━━━━━━━';

export const rotuloLoja = l => [l.bairro, l.cidade?.replace(/\s*-\s*/, '/')].filter(Boolean).join(', ');

export function blocoLoja(l, marcados) {
  const peds = l.pedidos.map(p => ({ p, a: p.ajustes.filter(a => marcados.has(a.id)) })).filter(x => x.a.length);
  if (!peds.length) return null;
  const out = [SEP, `🏪 *${l.nome}*`];
  const sub = [rotuloLoja(l), l.cnpj ? `CNPJ ${l.cnpj}` : ''].filter(Boolean).join(' | ');
  if (sub) out.push(sub);
  for (const { p, a } of peds) {
    out.push('', `🧾 *Pedido ${p.numero ?? 'sem número'}*`);
    const pr = a.filter(x => x.tipo === 'preco'), qt = a.filter(x => x.tipo === 'qtd');
    if (pr.length) { out.push('', '💰 *Preço*'); out.push(pr.map(x => `*${x.sku}* - ${nomeProduto(x.produto)}\nDe ${brl(x.de)} para *${brl(x.para)}/${un(x)}*`).join('\n\n')); }
    if (qt.length) { out.push('', '📦 *Quantidade*'); out.push(qt.map(x => `*${x.sku}* - ${nomeProduto(x.produto)}\nDe ${qtd(x.de)} ${un(x)} para *${qtd(x.para)} ${un(x)}* (múltiplo de ${qtd(x.multiplo)} ${un(x)})`).join('\n\n')); }
  }
  return out.join('\n');
}

export function mensagem(lojas, marcados, soLoja = null) {
  const alvo = soLoja ? [soLoja] : lojas;
  const blocos = alvo.map(l => blocoLoja(l, marcados)).filter(Boolean);
  const plural = alvo.length > 1 || alvo[0]?.pedidos.length > 1;
  if (!blocos.length) return `Olá, tudo bem?\n\nConferi ${plural ? 'os pedidos' : 'o pedido'} com a nossa tabela e está tudo certo: preços e quantidades conferem.\n\nObrigado!`;
  const partes = ['Olá, tudo bem?', '', `Conferi ${plural ? 'os pedidos' : 'o pedido'} com a nossa tabela e preciso dos ajustes abaixo${alvo.length > 1 ? ', separados por loja' : ''}:`, '', blocos.join('\n\n')];
  const semAjuste = alvo.filter(l => !blocoLoja(l, marcados));
  if (semAjuste.length) partes.push('', SEP, `✅ *Sem ajustes:* ${semAjuste.map(l => [l.nome, l.bairro].filter(Boolean).join(' - ')).join('; ')}`);
  partes.push('', SEP, `Pode me enviar ${plural ? 'os pedidos atualizados' : 'o pedido atualizado'}, por favor? Obrigado!`);
  return partes.join('\n');
}
