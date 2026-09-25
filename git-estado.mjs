// Instalado pelo `claude-missao` em .claude/missao/git-estado.mjs; edite no repositório claude-missao e reinstale.
// Lê o estado do git sem alterar nada e imprime um JSON numa linha, para o workflow missao conferir o repositório
// sem depender da leitura de um modelo.
//
// Uso: node .claude/missao/git-estado.mjs <base>
// Saída: { head, branch, raiz, limpo, pendencias[], commits[] (base..HEAD, do mais antigo ao mais novo, SHAs completos),
//          arquivos[] (diff --name-only base..HEAD), arquivosPorCommit { sha: [arquivos] },
//          contagem { commits, arquivos, pendencias } (o workflow confere contra as listas) }
import { execFileSync } from 'node:child_process'

const git = (...a) => execFileSync('git', ['-c', 'core.quotepath=false', ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const linhas = texto => texto.split('\n').map(l => l.replace(/\r$/, '')).filter(l => l.trim())

const base = process.argv[2]
if (!base) {
  console.error('uso: node git-estado.mjs <base>')
  process.exit(2)
}
const intervalo = `${git('rev-parse', '--verify', `${base}^{commit}`).trim()}..HEAD`
const pendencias = linhas(git('status', '--porcelain'))
const commits = linhas(git('rev-list', '--reverse', intervalo))
const arquivos = linhas(git('diff', '--name-only', intervalo))
const arquivosPorCommit = Object.fromEntries(commits.map(sha =>
  [sha, linhas(git('diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-m', '--first-parent', sha))]))
console.log(JSON.stringify({
  head: git('rev-parse', 'HEAD').trim(),
  branch: git('branch', '--show-current').trim(),
  raiz: git('rev-parse', '--show-toplevel').trim(),
  limpo: pendencias.length === 0,
  pendencias,
  commits,
  arquivos,
  arquivosPorCommit,
  contagem: { commits: commits.length, arquivos: arquivos.length, pendencias: pendencias.length },
}))
