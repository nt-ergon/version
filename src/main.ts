import * as core from '@actions/core'
import * as github from '@actions/github'
import { GitHub } from '@actions/github/lib/utils'
// eslint-disable-next-line import/no-unresolved
import { components } from '@octokit/openapi-types'
import * as fs from 'fs'
import * as process from 'process'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const octokit = github.getOctokit(core.getInput('token'))

    const tags = await getTags(octokit)
    const history = await getHistory(process.env.GITHUB_SHA as string, octokit)
    const { tag, distance } = await findClosestTag(tags, history)
    let version: string
    if (distance < 0) {
      // no tag found
      version = process.env.GITHUB_SHA as string
    } else if (distance === 0) {
      version = tag
    } else {
      version = `${tag}-${distance}-${process.env.GITHUB_SHA}`
    }
    core.setOutput('version', version)
    fs.appendFileSync(process.env.GITHUB_ENV as string, `VERSION=${version}`)
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}

const pageSize = 100

// Maps commit SHA to Tag-Name
async function getTags(
  octokit: InstanceType<typeof GitHub>
): Promise<Map<string, string>> {
  const result = new Map<string, string>()

  let page = 0
  let fetchCount = 0
  do {
    const { data: tags } = await octokit.rest.repos.listTags({
      ...github.context.repo,
      per_page: pageSize,
      page
    })
    fetchCount = tags.length
    page += 1

    for (const tag of tags) {
      result.set(tag.commit.sha, tag.name)
    }
  } while (fetchCount === pageSize)

  return result
}

interface GitCommit {
  readonly sha: string

  parents(): Promise<GitCommit[]>

  visited: boolean
}

type Commit = components['schemas']['commit']

class LazyGitCommit implements GitCommit {
  private readonly commitProvider: (sha: string) => Promise<Commit>
  private parentSha: string[]
  sha: string
  visited = false

  constructor(
    rawCommit: Commit,
    commitProvider: (sha: string) => Promise<Commit>
  ) {
    this.commitProvider = commitProvider
    this.sha = rawCommit.sha
    this.parentSha = rawCommit.parents.map(it => it.sha)
  }

  async parents(): Promise<GitCommit[]> {
    return Promise.all(
      this.parentSha.map(
        async it =>
          new LazyGitCommit(await this.commitProvider(it), this.commitProvider)
      )
    )
  }
}

async function getHistory(
  sha: string,
  octokit: InstanceType<typeof GitHub>
): Promise<GitCommit> {
  const commits = new Map<string, Commit>()
  let page = 0
  const provider: (hash: string) => Promise<Commit> = async hash => {
    while (!commits.has(hash)) {
      const { data: rawCommits } = await octokit.rest.repos.listCommits({
        ...github.context.repo,
        sha: hash,
        page,
        per_page: pageSize
      })
      page += 1
      for (const commit of rawCommits) {
        commits.set(commit.sha, commit)
      }
      if (rawCommits.length < pageSize) {
        break
      }
    }
    const commit = commits.get(hash)
    if (commit === undefined) {
      throw Error(
        `commit ${hash} was undefined, must not happen, all commits should be loaded. ${JSON.stringify({ page, commits })}`
      )
    }
    return commit
  }
  return new LazyGitCommit(await provider(sha), provider)
}

async function findClosestTag(
  tags: Map<string, string>,
  history: GitCommit
): Promise<{
  tag: string
  distance: number
}> {
  const todo = [history, null]
  let depth = 0
  while (todo.length > 0) {
    const head = todo.shift() as GitCommit | null
    if (head === null) {
      depth += 1
      todo.push(null)
      continue
    }
    if (head.visited) {
      continue
    }
    const candidateTag = tags.get(head.sha)
    if (candidateTag !== undefined) {
      return { tag: candidateTag, distance: depth }
    } else {
      head.visited = true
      todo.push(...(await head.parents()))
    }
  }
  return { tag: '', distance: -1 }
}
