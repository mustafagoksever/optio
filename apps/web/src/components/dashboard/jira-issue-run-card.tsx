"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Play, Loader2, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";

export function JiraIssueRunCard() {
  const router = useRouter();
  const [repos, setRepos] = useState<any[]>([]);
  const [repoId, setRepoId] = useState("");
  const [issueKey, setIssueKey] = useState("");
  const [loadingRepos, setLoadingRepos] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api
      .listRepos()
      .then((res) => {
        setRepos(res.repos);
        const firstRunnable = res.repos.find((repo: any) => repo.customDockerImageUrl);
        if (firstRunnable) setRepoId(firstRunnable.id);
      })
      .catch(() => toast.error("Failed to load repositories"))
      .finally(() => setLoadingRepos(false));
  }, []);

  const selectedRepo = useMemo(() => repos.find((repo) => repo.id === repoId), [repoId, repos]);
  const canRun = !!selectedRepo?.customDockerImageUrl && issueKey.trim().length > 0 && !submitting;

  const submit = async () => {
    if (!canRun) return;
    setSubmitting(true);
    try {
      const res = await api.runJiraIssue({ repoId, issueKey: issueKey.trim().toUpperCase() });
      toast.success("Jira task queued");
      router.push(`/tasks/${res.task.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to queue Jira task");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="p-4 rounded-xl border border-border/50 bg-bg-card space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-text-heading">Run Jira Issue</h2>
        <Link href="/repos" className="text-xs text-primary hover:underline">
          Repos
        </Link>
      </div>

      <div className="grid md:grid-cols-[1fr_12rem_auto] gap-2">
        <select
          value={repoId}
          onChange={(e) => setRepoId(e.target.value)}
          disabled={loadingRepos || repos.length === 0}
          className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary"
        >
          {loadingRepos && <option>Loading repos...</option>}
          {!loadingRepos && repos.length === 0 && <option>No repos configured</option>}
          {repos.map((repo) => (
            <option key={repo.id} value={repo.id} disabled={!repo.customDockerImageUrl}>
              {repo.fullName ?? repo.repoUrl}
              {!repo.customDockerImageUrl ? " (image required)" : ""}
            </option>
          ))}
        </select>
        <input
          value={issueKey}
          onChange={(e) => setIssueKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="OPT-123"
          className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm uppercase focus:outline-none focus:border-primary"
        />
        <button
          onClick={submit}
          disabled={!canRun}
          className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-primary text-white text-sm hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          Run
        </button>
      </div>

      {selectedRepo && !selectedRepo.customDockerImageUrl && (
        <p className="flex items-center gap-1.5 text-xs text-warning">
          <AlertCircle className="w-3 h-3" />
          Set customDockerImageUrl before running Jira issues for this repo.
        </p>
      )}
    </section>
  );
}
