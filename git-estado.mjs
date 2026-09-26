// Instalado pelo `claude-missao` em .claude/missao/git-estado.mjs; edite no repositório claude-missao e reinstale.
// Lê o estado do git sem alterar nada e imprime um JSON numa linha, para o workflow missao conferir o repositório
// sem depender da leitura de um modelo.
//
// Uso: node .claude/missao/git-estado.mjs <base>
// Saída: { head, branch, raiz, limpo, pendencias[], commits[] (base..HEAD, do mais antigo ao mais novo, SHAs completos),
//          arquivos[] (diff --name-only base..HEAD), arquivosPorCommit { sha: [arquivos] },
//          contagem { commits, arquivos, pendencias } (o workflow confere contra as listas) }
//
// Modo compacto, para a retomada de missão grande: node .claude/missao/git-estado.mjs <inicio> --resumo <base> [<sha de fora>...]
// Sem arquivosPorCommit: arquivos[] é a união dos arquivos dos commits de inicio..HEAD menos os commits de fora, e
// arquivosDoMilestone[] a mesma união só dos commits depois de <base>. Saída com resumo: true e a contagem das listas.
import { execFileSync } from 'node:child_process'

const git = (...a) => execFileSync('git', ['-c', 'core.quotepath=false', ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const linhas = texto => texto.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim())

const [base, modo, baseMilestone, ...deFora] = process.argv.slice(2)
if (!base || (modo && (modo !== '--resumo' || !baseMilestone))) {
  console.error('uso: node git-estado.mjs <base> [--resumo <base do milestone> [<sha de fora>...]]')
  process.exit(2)
}
const completo = ref => git('rev-parse', '--verify', `${ref}^{commit}`).trim()
const inicio = completo(base)
const intervalo = `${inicio}..HEAD`
// -uall: pasta nova aparece arquivo por arquivo, e não como `?? pasta/`.
const pendencias = linhas(git('status', '--porcelain', '-uall'))
const commits = linhas(git('rev-list', '--reverse', intervalo))
const arquivosDe = sha => linhas(git('diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-m', '--first-parent', sha))
const estado = {
  head: git('rev-parse', 'HEAD').trim(),
  branch: git('branch', '--show-current').trim(),
  raiz: git('rev-parse', '--show-toplevel').trim(),
  limpo: pendencias.length === 0,
  pendencias,
  commits,
}
if (modo) {
  const mesmo = (a, b) => a.startsWith(b) || b.startsWith(a)
  const daMissao = commits.filter(s => !deFora.some(d => mesmo(s, d)))
  const alvo = completo(baseMilestone)
  const desde = alvo === inicio ? 0 : commits.indexOf(alvo) + 1
  const uniao = lista => [...new Set(lista.flatMap(arquivosDe))]
  const arquivos = uniao(daMissao)
  const arquivosDoMilestone = desde > 0 || alvo === inicio ? uniao(daMissao.filter(s => commits.indexOf(s) >= desde)) : []
  console.log(JSON.stringify({
    ...estado, resumo: true, arquivos, arquivosDoMilestone,
    contagem: { commits: commits.length, arquivos: arquivos.length, arquivosDoMilestone: arquivosDoMilestone.length, pendencias: pendencias.length },
  }))
} else {
  const arquivos = linhas(git('diff', '--name-only', intervalo))
  console.log(JSON.stringify({
    ...estado,
    arquivos,
    arquivosPorCommit: Object.fromEntries(commits.map(sha => [sha, arquivosDe(sha)])),
    contagem: { commits: commits.length, arquivos: arquivos.length, pendencias: pendencias.length },
  }))
}
