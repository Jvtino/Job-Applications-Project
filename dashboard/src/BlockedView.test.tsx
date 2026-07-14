// "Needs you" tab: lists applications the pilot parked for a login/CAPTCHA and lets the user open
// each posting by hand. These tests cover the populated table (reason pills + Open links) and the
// friendly empty state.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { BlockedView } from "./ChronicleDashboard";
import type { BlockedApplication } from "./data";

const sample: BlockedApplication[] = [
  { id: "b1", title: "Head of Product", company: "Northstar Labs", url: "https://job-boards.greenhouse.io/northstarlabs/jobs/1", reason: "login", reasonLabel: "Sign in to continue" },
  { id: "b2", title: "Growth Product Lead", company: "Copperline", url: "https://jobs.lever.co/copperline/2", reason: "captcha", reasonLabel: "CAPTCHA to solve" },
];

describe("BlockedView", () => {
  it("shows the explainer, a reason pill per job, and one Open link per job", () => {
    render(<BlockedView blocked={sample} />);

    expect(screen.getByText(/paused for a login or CAPTCHA/i)).toBeInTheDocument();
    expect(screen.getByText("Sign in to continue")).toBeInTheDocument();
    expect(screen.getByText("CAPTCHA to solve")).toBeInTheDocument();

    const links = screen.getAllByRole("link", { name: /open/i });
    expect(links).toHaveLength(2);
    // Opens the posting in a new tab via a plain anchor — no apply/submit call.
    expect(links[0]).toHaveAttribute("href", sample[0]!.url);
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0]).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("renders a friendly empty state and no Open links when nothing is blocked", () => {
    render(<BlockedView blocked={[]} />);

    expect(screen.getByText(/Nothing needs you right now/i)).toBeInTheDocument();
    expect(screen.getByText(/Blocked applications will collect here/i)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open/i })).toBeNull();
  });
});
