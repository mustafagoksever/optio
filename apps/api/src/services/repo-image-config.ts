import type { PresetImageId, RepoImageConfig } from "@optio/shared";

export function buildRepoImageConfig(
  repoConfig?: { customDockerImageUrl?: string | null; imagePreset?: string | null } | null,
): RepoImageConfig | undefined {
  if (!repoConfig) return undefined;
  const customImage = repoConfig.customDockerImageUrl?.trim();
  if (customImage) return { customImage };
  return { preset: (repoConfig.imagePreset ?? "base") as PresetImageId };
}
