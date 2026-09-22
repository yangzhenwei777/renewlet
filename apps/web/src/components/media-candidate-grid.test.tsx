// 媒体候选网格测试保护分组、置信度和键盘选择体验，避免 Logo/Icon resolver 结果无法稳定选择。
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { MediaCandidate, MediaCandidateGroup } from "@/lib/api/schemas/media";
import { MediaCandidateGrid } from "./media-candidate-grid";

function builtInCandidate(overrides: Partial<MediaCandidate> = {}): MediaCandidate {
  return {
    id: "builtin:thesvg:netflix:default",
    kind: "logo",
    source: "builtIn",
    provider: "thesvg",
    label: "Netflix",
    variant: "default",
    url: "https://testingcf.jsdelivr.net/gh/glincker/thesvg@main/public/icons/netflix/default.svg",
    confidence: "exact",
    autoAssignable: true,
    matchedQuery: "netflix",
    rank: 0,
    ...overrides,
  };
}

function faviconCandidate(overrides: Partial<MediaCandidate> = {}): MediaCandidate {
  return {
    id: "favicon:site:apple.com:0",
    kind: "logo",
    source: "favicon",
    provider: "site",
    label: "apple.com",
    variant: null,
    url: "https://apple.com/favicon.ico",
    confidence: "weak",
    autoAssignable: false,
    matchedQuery: "apple.com",
    rank: 0,
    ...overrides,
  };
}

function appStoreCandidate(overrides: Partial<MediaCandidate> = {}): MediaCandidate {
  return {
    id: "appstore:us:123",
    kind: "logo",
    source: "appStore",
    provider: "appStore",
    label: "Apple Music",
    variant: null,
    url: "https://is1-ssl.mzstatic.com/image/thumb/apple-music.png",
    confidence: "strong",
    autoAssignable: false,
    matchedQuery: "apple music",
    rank: 0,
    ...overrides,
  };
}

function candidateGroup(group: Partial<MediaCandidateGroup>): MediaCandidateGroup {
  return {
    best: null,
    builtIn: [],
    appStore: [],
    favicon: [],
    ...group,
  };
}

function renderGrid(candidates: MediaCandidateGroup, onError = vi.fn<(candidate: MediaCandidate) => void>()) {
  const onSelect = vi.fn();
  const result = render(
    <MediaCandidateGrid
      candidates={candidates}
      onError={onError}
      onSelect={onSelect}
    />,
  );
  return {
    onError,
    onSelect,
    ...result,
    rerenderGrid: (nextCandidates: MediaCandidateGroup) => result.rerender(
      <MediaCandidateGrid
        candidates={nextCandidates}
        onError={onError}
        onSelect={onSelect}
      />,
    ),
  };
}

describe("MediaCandidateGrid provider filters", () => {
  it("keeps built-in, App Store and favicon sections inside one compact spacing container", () => {
    const { container } = renderGrid(candidateGroup({ builtIn: [builtInCandidate()], appStore: [appStoreCandidate()], favicon: [faviconCandidate()] }));

    const sections = container.querySelector(".media-candidate-grid-sections");
    expect(sections).not.toBeNull();
    expect(sections).toHaveClass("grid", "gap-2");
    expect(sections?.querySelectorAll("section")).toHaveLength(3);
    expect(screen.getByText("App Store：")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apple Music" })).toBeInTheDocument();
  });

  it("does not leave an empty spacing container without candidates", () => {
    const { container } = renderGrid(candidateGroup({}));

    expect(container.querySelector(".media-candidate-grid-sections")).toBeNull();
  });

  it("filters built-in candidates by visible provider tags and keeps favicon fallback visible", async () => {
    const user = userEvent.setup();
    const netflix = builtInCandidate();
    const actualBudget = builtInCandidate({
      id: "builtin:selfhst:actual-budget:default",
      provider: "selfhst",
      label: "Actual Budget",
      url: "https://testingcf.jsdelivr.net/gh/selfhst/icons@main/svg/actual-budget.svg",
      matchedQuery: "actual budget",
      rank: 1,
    });
    renderGrid(candidateGroup({ builtIn: [netflix, actualBudget], favicon: [faviconCandidate()] }));

    const filterGroup = screen.getByRole("group", { name: "筛选内置图标来源" });
    expect(filterGroup).toHaveTextContent("全部");
    expect(filterGroup).toHaveTextContent("TheSVG");
    expect(filterGroup).toHaveTextContent("selfh.st");
    expect(filterGroup).not.toHaveTextContent("selfh.st icons");
    expect(filterGroup).not.toHaveTextContent("Dashboard");
    expect(within(filterGroup).getByRole("button", { name: /全部/ })).not.toHaveTextContent("✓");
    expect(screen.getByRole("button", { name: "Netflix - TheSVG / Default" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actual Budget - selfh.st icons / Default" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "apple.com" })).toBeInTheDocument();

    const selfhstFilter = within(filterGroup).getByRole("button", { name: /selfh\.st/ });
    await user.click(selfhstFilter);

    expect(selfhstFilter).toHaveAttribute("aria-pressed", "true");
    expect(selfhstFilter).not.toHaveTextContent("✓");
    expect(screen.queryByRole("button", { name: "Netflix - TheSVG / Default" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Actual Budget - selfh.st icons / Default" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "apple.com" })).toBeInTheDocument();

    await user.click(within(filterGroup).getByRole("button", { name: /全部/ }));
    expect(screen.getByRole("button", { name: "Netflix - TheSVG / Default" })).toBeInTheDocument();
  });

  it("returns provider filtering to all when the selected provider disappears", async () => {
    const user = userEvent.setup();
    const onError = vi.fn();
    const netflix = builtInCandidate();
    const actualBudget = builtInCandidate({
      id: "builtin:selfhst:actual-budget:default",
      provider: "selfhst",
      label: "Actual Budget",
      url: "https://testingcf.jsdelivr.net/gh/selfhst/icons@main/svg/actual-budget.svg",
      matchedQuery: "actual budget",
      rank: 1,
    });
    const view = renderGrid(candidateGroup({ builtIn: [netflix, actualBudget] }), onError);

    const filterGroup = screen.getByRole("group", { name: "筛选内置图标来源" });
    await user.click(within(filterGroup).getByRole("button", { name: /selfh\.st/ }));
    expect(screen.queryByRole("button", { name: "Netflix - TheSVG / Default" })).not.toBeInTheDocument();

    screen.getByAltText("Actual Budget - selfh.st icons / Default").dispatchEvent(new Event("error", { bubbles: true }));
    expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ id: actualBudget.id }));
    view.rerenderGrid(candidateGroup({ builtIn: [netflix] }));

    await waitFor(() => {
      expect(screen.queryByRole("group", { name: "筛选内置图标来源" })).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Netflix - TheSVG / Default" })).toBeInTheDocument();
  });

  it("hides provider filters for single-provider built-in results", () => {
    renderGrid(candidateGroup({ builtIn: [builtInCandidate()] }));

    expect(screen.getByRole("button", { name: "Netflix - TheSVG / Default" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "筛选内置图标来源" })).not.toBeInTheDocument();
  });
});
