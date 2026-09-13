"""
TEO Team KPI Tracker
====================
Tracks monthly KPIs from Jira (GM project) + Salesforce (Case object).

Jira-side KPIs (always available):
  2. Ticket to QA   = GM EA tickets that reached QA / total GM EA tickets
  3. EA to Bug      = GM EA tickets with linked bug / GM EA tickets that reached QA
  4. Ticket to Bug  = GM EA tickets with linked bug / total GM EA tickets

Salesforce-side KPIs (require `sf org login web` once):
  1. Ticket to GM       = SF Cases linked to a GM EA ticket / total SF cases
  5. Escalation rate    = Cases marked IsEscalated / total cases
  6. MTTR (closed)      = mean & median CreatedDate→ClosedDate for closed cases
  7. Severity mix       = breakdown by SLA_Category__c on cases

Auth model: Salesforce CLI (`sf`) — login once with `sf org login web`, the
app reads the live access token via `sf org display --json`. Falls back to
OAuth2 client_credentials (SF_CLIENT_ID + SF_CLIENT_SECRET in .env, server
deployments where no interactive login is possible) and then to a manual
session-ID paste if neither is available.
"""

# Future-import lets the file use Python 3.10+ generic syntax (`set[str]`,
# `dict[str, list[str]]`) even when running on Python 3.9 (e.g. the remote
# supervisor host). All annotations become lazy strings; runtime behavior
# is unchanged.
from __future__ import annotations

import calendar
import json
import os
import re
import shutil
import subprocess
from datetime import date, datetime
from typing import List, Optional

import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st
from dotenv import load_dotenv

load_dotenv(override=True)

# ── Salesforce CLI integration ─────────────────────────────────────────────────
SF_DEFAULT_ALIAS = os.getenv("SF_CLI_ALIAS", "greyorange")


def _find_sf_cli() -> Optional[str]:
    """Locate the `sf` binary. PATH first, then common install locations."""
    path_hit = shutil.which("sf")
    if path_hit:
        return path_hit
    for candidate in (
        os.path.expanduser("~/.npm-global/bin/sf"),
        "/usr/local/bin/sf",
        "/opt/homebrew/bin/sf",
    ):
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


@st.cache_data(ttl=300, show_spinner=False)
def sf_cli_session(alias: str) -> Optional[dict]:
    """
    Return {'access_token', 'instance_url', 'username', 'alias'} from SF CLI,
    or None if CLI is missing / not logged in. Cached 5 min — SF tokens are
    long-lived but the CLI auto-refreshes on use.
    """
    sf_bin = _find_sf_cli()
    if not sf_bin:
        return None
    try:
        result = subprocess.run(
            [sf_bin, "org", "display", "--target-org", alias, "--json"],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode != 0:
            return None
        data = json.loads(result.stdout).get("result", {})
        if not data.get("accessToken") or not data.get("instanceUrl"):
            return None
        return {
            "access_token": data["accessToken"],
            "instance_url": data["instanceUrl"].rstrip("/"),
            "username": data.get("username", ""),
            "alias": data.get("alias", alias),
        }
    except Exception:
        return None

# ── Hardcoded business config (from PDF + confirmed via live Jira data) ────────
JIRA_URL = "https://greyorange-work.atlassian.net"
GM_PROJECT = "GM"
EA_ISSUE_TYPE = "Engineering Analysis"
BUG_ISSUE_TYPE = "Bug"

# Scope filters — exclude hardware-tagged EA tickets; TEO is software-only.
# There's no literal "software" label in the GM project — the team marks the
# small minority that ARE hardware (HW_Support, TTP_HW_SUPPORT). Everything
# else is software by default. So we filter by exclusion, not inclusion.
EA_EXCLUDED_LABELS = ("HW_Support", "TTP_HW_SUPPORT")
# Salesforce case scope: only real defects (not Alerts/SR/Query/FR) on TEO-owned products.
SF_CASE_TYPES = ("Incident",)
SF_PRODUCT_TYPES = ("RTP", "TTP")
TEO_LABELS = ("pdu_reviewed", "teo_reviewed")

# Pod assignment — accounts are grouped into PODs in this spreadsheet.
# The dashboard exposes a pod dropdown that maps to the contents below.
POD_LIST_PATH = os.path.expanduser(
    os.getenv("POD_LIST_PATH", "~/Downloads/Pod list.xlsx")
)


@st.cache_data(ttl=600, show_spinner=False)
def load_pod_map(path: str) -> dict[str, list[str]]:
    """
    Read the pod spreadsheet. Each column header is a pod name; each non-null
    cell is an account/site name. Returns {pod_name: [account_names]}.
    Cached for 10 min — edit the xlsx and click Fetch to refresh.
    """
    try:
        import pandas as _pd
        sheet = _pd.read_excel(path, sheet_name=0)
    except FileNotFoundError:
        return {}
    except Exception:
        return {}
    pods: dict[str, list[str]] = {}
    for col in sheet.columns:
        vals = [str(v).strip() for v in sheet[col].dropna().tolist() if str(v).strip()]
        if vals:
            pods[str(col).strip()] = vals
    return pods


def _normalize_name(s: str) -> str:
    """Lowercase + strip every non-alphanumeric char. Used for fuzzy matches."""
    return "".join(ch for ch in (s or "").lower() if ch.isalnum())


def _build_pod_lookup(pod_map: dict[str, list[str]]) -> list[tuple[str, str]]:
    """Return [(normalized_account_substring, pod_name), …] for substring matching."""
    pairs: list[tuple[str, str]] = []
    for pod, names in pod_map.items():
        for nm in names:
            n = _normalize_name(nm)
            if n:
                pairs.append((n, pod))
    # Longest-first so 'gxonike' matches 'gxonikebloomington…' specifically
    pairs.sort(key=lambda p: -len(p[0]))
    return pairs


def account_pod(account_name: str, lookup: list[tuple[str, str]]) -> Optional[str]:
    """Resolve an SF account name to its pod via normalized substring matching."""
    if not account_name:
        return None
    n = _normalize_name(account_name)
    if not n:
        return None
    for needle, pod in lookup:
        if needle in n or n in needle:
            return pod
    return None


def _ea_label_clause() -> str:
    """JQL fragment that excludes hardware-tagged EA tickets."""
    if not EA_EXCLUDED_LABELS:
        return ""
    quoted = ", ".join(f'"{lab}"' for lab in EA_EXCLUDED_LABELS)
    # `labels not in (...)` matches tickets where labels is empty too.
    return f'AND (labels is EMPTY OR labels not in ({quoted})) '

QA_STATUSES = {"Queued for QA analysis", "QA analysis in progress"}
DEV_STATUS = "Queued for dev analysis"

# Bug-outcome resolutions — drive both EA→Bug and Ticket→Bug numerators.
BUG_RESOLUTIONS = {
    "New Bug",
    "Known Bug",
    "Wrong Technical Configuration",
    "Wrong Feature Configuration",
    "Feature Gap",
}

# "In Progress" = EA is still being actively worked on (any of these statuses).
# Used for the Ticket → QA [In Progress] counterpart KPI.
IN_PROGRESS_STATUSES = {
    "TAC Analysis",
    "Reopened",
    "Need More Info",
    "Queued for QA analysis",
    "QA analysis in progress",
    "Queued for Dev Analysis",
    "Dev Analysis in progress",
}

# "Concluded" = the EA has been resolved (Jira status = Done with a resolution).
CONCLUDED_STATUS = "Done"

# Stricter bug definition used by the SF Case Flow / EA Ticket Flow funnels
# and by the TEO Leakage calculation. Excludes "wrong configuration" outcomes
# since those imply customer-side fixes rather than product defects.
STRICT_BUG_RESOLUTIONS = {"New Bug", "Known Bug", "Missed Checkin"}

# Even narrower set used by the EA → Bug KPI per the Overview-sheet spec —
# only EAs that resolve as confirmed bugs (excludes Missed Checkin).
EA_BUG_KPI_RESOLUTIONS = {"Known Bug", "New Bug"}

# Process Gap resolutions — non-defect outcomes that still flag a process or
# configuration gap (as opposed to Invalid Use Case/Duplicate/No-issue closures).
# Feeds the EA → PG KPI. Direct resolution match only — no Duplicate-chase,
# since a Duplicate-resolved EA carries no PG signal of its own.
PROCESS_GAP_RESOLUTIONS = {
    "Wrong Technical Configuration",
    "Wrong Feature Configuration",
    "New Requirement",
    "Sysops Issue",
    "Upgrade Procedure",
}

# When an EA concludes as "Duplicate", it carries no bug signal of its own —
# the EA → Bug KPI instead follows the "duplicates"/"is duplicated by" link
# to the original EA(s) and counts THEIR resolution (Known Bug / New Bug,
# or another Duplicate hop) as this ticket's outcome.
DUPLICATE_RESOLUTION = "Duplicate"

# Bug-type issues carry this value in their STATUS field (not resolution —
# confirmed live: Bug resolutions are Done/Invalid Use Case/Cannot
# Reproduce/Duplicate/Unresolved, "Rejected" only shows up as a status).
BUG_REJECTED_STATUS = "Rejected"

# Statuses considered "concluded" for the bucket Concluded / In Progress
# split and for the Ticket → QA [In Progress] KPI. Per spec: a ticket is
# "concluded" if its status sits in this set (Done, No longer an issue, or
# Unable to Conclude — whether these are distinct workflow states or
# resolutions surfaced as statuses on this org's Jira).
CONCLUDED_STATUSES = {"Done", "No longer an issue", "Unable to Conclude"}

# Single status name checked by Ticket → QA — the EA's changelog must show
# a transition to THIS specific status (broader "Queued for QA analysis"
# doesn't count).
QA_IN_PROGRESS_STATUS = "QA analysis in progress"

# ── TEO filter ────────────────────────────────────────────────────────────────
# Identifies EAs resolved by the TEO team — two explicit Jira account IDs.
# Used to subtract TEO-owned tickets from the Ticket → QA numerator.
TEO_RESOLVED_BY_USERS_JQL = (
    "5d9f265545fad00dc1264c72, "
    "712020:0a1d470a-f897-4b00-8100-5efd5ce64d95"
)
TEO_STAGE_ARI = (
    "ari:cloud:cmdb::object/fc5b8d6f-f02e-4202-806d-1d41c9779519/9826"
)
TEO_FILTER_STATUSES_JQL = '"Done", "Unable to Conclude", "No longer an issue"'

TEO_CLOSURE_RESOLUTIONS = {
    "Logs Unavailable",
    "Invalid Use Case/No issue",
    "Incorrect Operating Procedure",
    "Manual Intervention",
    "No longer an issue",
    "Sysops Issue",
}

# ── KPI definitions (rendered as info tooltips on each metric) ────────────────
# Period-strict: a GM EA counts toward an SF-side KPI ONLY if it was created
# inside the selected month. This avoids double-counting old GMs that newer SF
# cases link back to.
KPI_RULES = {
    "Ticket → GM": (
        "**Ticket → GM** = SF cases that have ANY linked GM-XXX ticket "
        "(regardless of when the EA was created) ÷ total SF cases.\n\n"
        "Numerator: `sf_any_gm_link` — SF cases where "
        "`Jira_Ticket_Id__c` / `Jira_Ticket_URL__c` resolves to a GM-XXX. "
        "EA creation date is **NOT** filtered here.\n\n"
        "Denominator: SF cases in the period with Type = Incident "
        "AND Product_Type__c ∈ (RTP, TTP), narrowed by the active Pod filter."
    ),
    "Ticket → TEO": (
        "**Ticket → TEO** = SF cases whose linked GM EA was **created in "
        "the selected month** ÷ total SF cases.\n\n"
        "Numerator: `sf_linked_to_gm` — SF cases whose linked GM passes the "
        "period-strict gate (EA created within selected month).\n\n"
        "Denominator: total SF cases in scope.\n\n"
        "This is the period-strict counterpart of Ticket → GM."
    ),
    "Ticket → QA": (
        "**Ticket → QA** = SF cases linked to a Month EA that is NOT in the "
        "TEO-resolved filter set ÷ total SF cases.\n\n"
        "Numerator: SF cases where the linked GM EA was created in the "
        "selected month AND is NOT a TEO-resolved ticket. By construction "
        "this equals the SF count on the **`SF Cases / EA reached to QA`** "
        "bucket card.\n\n"
        "TEO-resolved set comes from the JQL: "
        "`project=GM AND type=\"Engineering Analysis\" AND \"Resolved By\" "
        "in (5d9f...c72, 712020:0a1d...95) AND createdDate ≥ <period start> "
        "AND (cf[10689] = \"Production\" OR cf[10121] = <TEO stage>) AND status in (Done, Unable to Conclude, "
        "No longer an issue)`.\n\n"
        "Denominator: total SF cases in scope.\n\n"
        "Note: the earlier `QA analysis in progress` changelog gate was "
        "removed so the SF count aligns with the bucket card. EAs that "
        "closed at TAC without crossing QA are now included."
    ),
    "EA → Bug": (
        "**EA → Bug** = QA-concluded Month EAs whose resolution ∈ "
        "{Known Bug, New Bug} ÷ QA-concluded Month EAs.\n\n"
        "Numerator: subset of **Month EAs — Concluded** (bucket card "
        "`Month EAs — Concluded`) whose resolution is `Known Bug` or "
        "`New Bug`. An EA resolved as `Duplicate` carries no bug signal of "
        "its own — it instead inherits the outcome of the EA it links to "
        "(chased through further Duplicate hops if needed), and counts as "
        "a bug here if that linked EA resolved as `Known Bug`/`New Bug` "
        "**or has a Bug-type issue linked to it** (regardless of its own "
        "resolution field).\n\n"
        "Denominator: **Month EAs — Concluded** — Month EAs that have "
        "concluded (status ∈ Done / No longer an issue / Unable to Conclude) "
        "AND are NOT in the TEO-resolved filter set. TEO-resolved EAs live "
        "in their own bucket (`concluded from TEO`) and don't count toward "
        "this QA-throughput KPI.\n\n"
        "EA-quantified, not SF-quantified."
    ),
    "Bug Rejection %": (
        "**Bug Rejection %** = Month EAs — Concluded, DIRECTLY resolved as "
        "`Known Bug`/`New Bug` (own resolution field — excludes "
        "Duplicate-chased ones), whose linked Bug-type issue has STATUS = "
        "`Rejected` ÷ that same direct-bug EA set.\n\n"
        "Numerator: of those direct-resolution EAs, the ones with at least "
        "one linked Bug issue currently sitting in `Rejected` status.\n\n"
        "Denominator: EAs in **Month EAs — Concluded** whose OWN resolution "
        "is `Known Bug` or `New Bug` (a strict subset of the EA → Bug "
        "numerator — Duplicate-chased bug outcomes are excluded since the "
        "rejection check needs a Bug issue linked to THIS EA specifically).\n\n"
        "`Rejected` lives on the Bug issue's **status** field, not its "
        "resolution (Bug resolutions in this project are Done / Invalid Use "
        "Case-No issue / Cannot Reproduce / Duplicate / Unresolved — "
        "`Rejected` only shows up as a status)."
    ),
    "EA → PG": (
        "**EA → PG (Process Gaps)** = QA-concluded Month EAs whose "
        "resolution ∈ {Wrong Technical Configuration, Wrong Feature "
        "Configuration, New Requirement, Sysops Issue, Upgrade Procedure} "
        "÷ QA-concluded Month EAs.\n\n"
        "Numerator: subset of **Month EAs — Concluded** whose resolution "
        "is one of the five codes above — direct resolution match only, "
        "**no Duplicate-chase** (a Duplicate carries no PG signal of its "
        "own, unlike the EA → Bug numerator).\n\n"
        "Denominator: **Month EAs — Concluded** — same denominator as "
        "EA → Bug.\n\n"
        "EA-quantified, not SF-quantified."
    ),
    "EA → Improvements": (
        "**EA → Improvements** = QA-concluded Month EAs whose resolution "
        "counts toward EITHER EA → Bug OR EA → PG ÷ QA-concluded Month "
        "EAs.\n\n"
        "Numerator: union of the EA → Bug numerator set and the EA → PG "
        "numerator set (a ticket can't be in both, since resolution is a "
        "single field, so this is a plain count union).\n\n"
        "Denominator: **Month EAs — Concluded** — same denominator as "
        "EA → Bug and EA → PG.\n\n"
        "Represents the share of concluded EAs that surfaced an "
        "actionable outcome (product defect or process/config gap) "
        "rather than closing as invalid/duplicate/no-issue/etc."
    ),
}

# ── Page config ────────────────────────────────────────────────────────────────
st.set_page_config(
    page_title="TEO KPI Tracker v2",
    page_icon="📊",
    layout="wide",
    initial_sidebar_state="collapsed",
)

st.title("TEO Team — Monthly KPI Tracker (v2)")

# ── Sidebar: credentials only ──────────────────────────────────────────────────
with st.sidebar:
    st.header("Credentials")
    st.caption("Stored in .env — fill once, never touch again.")

    jira_email = st.text_input(
        "Jira Email", value=os.getenv("JIRA_EMAIL", ""), type="default"
    )
    jira_token = st.text_input(
        "Jira API Token", value=os.getenv("JIRA_API_TOKEN", ""), type="password"
    )

    st.divider()
    st.caption("**Salesforce** — auth via `sf` CLI")
    sf_alias = st.text_input(
        "SF org alias",
        value=SF_DEFAULT_ALIAS,
        help="The alias you used with `sf org login web --alias <alias>`",
    )
    _sf_cli = sf_cli_session(sf_alias)
    _sf_session_id = ""
    _sf_instance_url = os.getenv(
        "SF_INSTANCE_URL", "https://greyorangeorg.my.salesforce.com"
    ).rstrip("/")
    if _sf_cli:
        st.success(f"✅ SF CLI connected as **{_sf_cli['username']}**")
        st.caption(f"Org: `{_sf_cli['alias']}` → {_sf_cli['instance_url']}")
        _sf_instance_url = _sf_cli["instance_url"]
    else:
        st.warning("⚠️ SF CLI not authenticated for this alias")
        st.caption(
            "Run in terminal:  \n"
            f"`sf org login web --alias {sf_alias}`  \n"
            "Then reload this page."
        )
        with st.expander("Fallback: paste session ID"):
            sf_session_id_input = st.text_input(
                "Session ID (from browser cookie `sid=`)",
                value=os.getenv("SF_SESSION_ID", "").strip(),
                type="password",
                placeholder="00DdN00000...!AQE...",
            )
            sf_instance_fallback = st.text_input(
                "Instance URL", value=_sf_instance_url,
            )
            _sf_session_id = sf_session_id_input.strip()
            _sf_instance_url = sf_instance_fallback.rstrip("/")

# ── View mode toggle ───────────────────────────────────────────────────────────
today = date.today()
view_mode = st.radio("View", ["Monthly", "Weekly"], horizontal=True)

if view_mode == "Monthly":
    col_m, col_y, col_btn = st.columns([2, 2, 3])
    with col_m:
        month = st.selectbox(
            "Month",
            options=list(range(1, 13)),
            index=today.month - 1,
            format_func=lambda m: datetime(2000, m, 1).strftime("%B"),
        )
    with col_y:
        year = st.selectbox(
            "Year",
            options=list(range(2024, today.year + 1)),
            index=list(range(2024, today.year + 1)).index(today.year),
        )
    with col_btn:
        st.write("")
        run = st.button("Fetch & Calculate", type="primary", use_container_width=True)

    _, last_day = calendar.monthrange(year, month)
    range_start = date(year, month, 1)
    range_end = date(year, month, last_day)
    period_label = datetime(year, month, 1).strftime("%B %Y")

else:  # Weekly
    col_w, col_btn = st.columns([4, 3])
    with col_w:
        # Default to start of current week (Monday)
        days_since_monday = today.weekday()
        default_monday = today - __import__("datetime").timedelta(days=days_since_monday)
        week_start = st.date_input("Week starting (Monday)", value=default_monday)
    with col_btn:
        st.write("")
        run = st.button("Fetch & Calculate", type="primary", use_container_width=True)

    import datetime as _dt
    # Snap to Monday
    week_start = week_start - _dt.timedelta(days=week_start.weekday())
    range_start = week_start
    range_end = week_start + _dt.timedelta(days=6)
    period_label = f"Week {range_start.strftime('%d %b')} – {range_end.strftime('%d %b %Y')}"

# ── Date range display ─────────────────────────────────────────────────────────
st.caption(
    f"Period: {range_start.strftime('%d %b %Y')} – {range_end.strftime('%d %b %Y')} "
    f"(created date filter) · EA tickets exclude hardware labels "
    f"({', '.join(EA_EXCLUDED_LABELS)}) · "
    f"SF cases filtered to `Product_Type__c IN {SF_PRODUCT_TYPES}`"
)

# ── Impact Analysis (SF Cases) ──────────────────────────────────────────────────
# New, independent feature — own month-range picker, own SF fetch (adds
# Impact_Percentage__c, which the rest of the app never queries), own chart.
# Does not call fetch_sf_cases / read SF_CASE_FIELDS / touch any existing
# function, so it renders regardless of whether the Monthly/Weekly flow above
# has been run yet.


def fetch_sf_cases_impact_analysis(start: str, end: str, alias: str,
                                    session_id: str, instance_url: str) -> list:
    """
    Fetch SF Incident cases (Software category, TEO product scope) created in
    [start, end], including Impact_Percentage__c. Auth precedence mirrors the
    rest of the app: sf CLI session -> OAuth2 client_credentials -> manual
    session ID.
    """
    import requests

    def _query(soql: str, token: str, inst: str) -> list:
        headers = {"Authorization": f"Bearer {token}"}
        records: list = []
        url = f"{inst}/services/data/v60.0/query"
        params = {"q": soql}
        while True:
            r = requests.get(url, headers=headers, params=params, timeout=60)
            r.raise_for_status()
            result = r.json()
            records.extend(result.get("records", []))
            if result.get("done"):
                break
            url = f"{inst}{result.get('nextRecordsUrl', '')}"
            params = {}
        return records

    types_clause = ", ".join(f"'{t}'" for t in SF_CASE_TYPES)
    products_clause = ", ".join(f"'{p}'" for p in SF_PRODUCT_TYPES)
    soql = (
        "SELECT CaseNumber, CreatedDate, Type, Category__c, Product_Type__c, "
        "Impact_Percentage__c FROM Case "
        f"WHERE CreatedDate >= {start}T00:00:00+05:30 "
        f"AND CreatedDate <= {end}T23:59:59+05:30 "
        f"AND Type IN ({types_clause}) "
        f"AND Product_Type__c IN ({products_clause}) "
        "AND Category__c = 'Software'"
    )

    cli = sf_cli_session(alias)
    if cli:
        return _query(soql, cli["access_token"], cli["instance_url"])

    client_id = os.getenv("SF_CLIENT_ID", "").strip()
    client_secret = os.getenv("SF_CLIENT_SECRET", "").strip()
    oauth_instance = os.getenv("SF_INSTANCE_URL", "").strip().rstrip("/")
    if client_id and client_secret and oauth_instance:
        resp = requests.post(
            f"{oauth_instance}/services/oauth2/token",
            data={"grant_type": "client_credentials", "client_id": client_id,
                  "client_secret": client_secret},
            timeout=20,
        )
        resp.raise_for_status()
        tok = resp.json()
        return _query(soql, tok["access_token"], tok.get("instance_url", oauth_instance))

    if session_id and instance_url:
        return _query(soql, session_id, instance_url.rstrip("/"))

    raise RuntimeError(
        "Salesforce not authenticated. Either (a) `sf org login web --alias "
        f"{alias}` locally, (b) set SF_CLIENT_ID + SF_CLIENT_SECRET + "
        "SF_INSTANCE_URL in .env, or (c) paste a session ID in the sidebar."
    )


def classify_impact_severity(pct: Optional[float]) -> str:
    """Bucket Impact_Percentage__c into the Impact Analysis severity scale."""
    if pct is None:
        return "Unclassified"
    if pct == 100:
        return "Sev 1"
    if pct >= 50:
        return "Sev 2 – Urgent"
    if 1 <= pct <= 49:
        return "Sev 2 – High"
    if pct < 1:
        return "Sev 3"
    return "Unclassified"


st.divider()
with st.expander("📊 Impact Analysis — SF Cases by severity (weekly)", expanded=False):
    from datetime import timedelta as _ia_timedelta

    st.caption(
        "Independent of the Monthly/Weekly KPI flow above. Severity is "
        "derived from `Impact_Percentage__c`: ==100% → Sev 1, ≥50% → "
        "Sev 2 (Urgent), 1–49% → Sev 2 (High), <1% → Sev 3."
    )
    ia_col_m, ia_col_y, ia_col_n, ia_col_btn = st.columns([2, 2, 2, 2])
    with ia_col_m:
        ia_end_month = st.selectbox(
            "End month", options=list(range(1, 13)),
            index=today.month - 1,
            format_func=lambda m: datetime(2000, m, 1).strftime("%B"),
            key="ia_end_month",
        )
    with ia_col_y:
        ia_end_year = st.selectbox(
            "End year", options=list(range(2024, today.year + 1)),
            index=list(range(2024, today.year + 1)).index(today.year),
            key="ia_end_year",
        )
    with ia_col_n:
        ia_n_months = st.selectbox(
            "Look back (months)", options=[1, 2, 3, 6, 12], index=2,
            key="ia_n_months",
        )
    with ia_col_btn:
        st.write("")
        ia_run = st.button("Fetch Impact Analysis", key="ia_run_btn",
                            use_container_width=True)

    if ia_run:
        _ia_end_idx = ia_end_year * 12 + (ia_end_month - 1)
        _ia_start_idx = _ia_end_idx - (ia_n_months - 1)
        ia_start_year, ia_start_month = _ia_start_idx // 12, _ia_start_idx % 12 + 1
        ia_range_start = date(ia_start_year, ia_start_month, 1)
        _, ia_last_day = calendar.monthrange(ia_end_year, ia_end_month)
        ia_range_end = date(ia_end_year, ia_end_month, ia_last_day)

        st.caption(
            f"Fetching: {ia_range_start.strftime('%d %b %Y')} – "
            f"{ia_range_end.strftime('%d %b %Y')}"
        )
        try:
            with st.spinner("Fetching Salesforce cases for Impact Analysis…"):
                ia_cases = fetch_sf_cases_impact_analysis(
                    ia_range_start.strftime("%Y-%m-%d"),
                    ia_range_end.strftime("%Y-%m-%d"),
                    sf_alias, _sf_session_id, _sf_instance_url,
                )
        except Exception as e:
            st.warning(f"Salesforce fetch failed: {e}")
            ia_cases = []

        if not ia_cases:
            st.info("No SF cases found for the selected range.")
        else:
            ia_rows = []
            for c in ia_cases:
                created_raw = c.get("CreatedDate")
                if not created_raw:
                    continue
                # Python 3.9's fromisoformat rejects offsets without a colon
                # (Salesforce sends "+0000", not "+00:00") — strptime's %z
                # accepts both forms.
                created_dt = datetime.strptime(
                    created_raw.replace("Z", "+0000"), "%Y-%m-%dT%H:%M:%S.%f%z"
                )
                week_start = created_dt.date() - _ia_timedelta(
                    days=created_dt.date().weekday()
                )
                ia_rows.append({
                    "case_number": c.get("CaseNumber", ""),
                    "week_start": week_start,
                    "impact_pct": c.get("Impact_Percentage__c"),
                    "severity": classify_impact_severity(c.get("Impact_Percentage__c")),
                })
            ia_df = pd.DataFrame(ia_rows)

            ia_grouped = (
                ia_df.groupby(["week_start", "severity"])
                .size()
                .reset_index(name="count")
                .sort_values("week_start")
            )
            ia_grouped["week_label"] = ia_grouped["week_start"].apply(
                lambda d: f"Week of {d.strftime('%d %b')}"
            )

            IA_SEVERITY_ORDER = ["Sev 1", "Sev 2 – Urgent", "Sev 2 – High",
                                 "Sev 3", "Unclassified"]
            IA_SEVERITY_COLORS = {
                "Sev 1": "#F44336",
                "Sev 2 – Urgent": "#FF9800",
                "Sev 2 – High": "#FFC107",
                "Sev 3": "#1976D2",
                "Unclassified": "#9AA0A6",
            }
            ia_week_labels_sorted = [
                f"Week of {d.strftime('%d %b')}"
                for d in sorted(ia_grouped["week_start"].unique())
            ]

            ia_fig = px.bar(
                ia_grouped,
                x="week_label",
                y="count",
                color="severity",
                category_orders={
                    "week_label": ia_week_labels_sorted,
                    "severity": IA_SEVERITY_ORDER,
                },
                color_discrete_map=IA_SEVERITY_COLORS,
                barmode="stack",
                title=(
                    f"Impact Analysis — {ia_range_start.strftime('%b %Y')} to "
                    f"{ia_range_end.strftime('%b %Y')} (weekly)"
                ),
            )
            # Total SF case count per week, labeled above each stacked bar —
            # mirrors the "Total SF Cases" figure the parent dashboard shows.
            ia_week_totals = ia_df.groupby("week_start").size().reindex(
                sorted(ia_df["week_start"].unique())
            )
            ia_fig.add_trace(
                go.Scatter(
                    x=[f"Week of {d.strftime('%d %b')}" for d in ia_week_totals.index],
                    y=ia_week_totals.values,
                    mode="text",
                    text=[f"Total: {int(v)}" for v in ia_week_totals.values],
                    textposition="top center",
                    showlegend=False,
                    hoverinfo="skip",
                )
            )
            ia_fig.update_layout(
                xaxis_title="Week",
                yaxis_title="Incident count",
                yaxis_range=[0, float(ia_week_totals.max()) * 1.18],
                height=440,
                margin=dict(l=20, r=20, t=50, b=20),
            )
            st.plotly_chart(ia_fig, use_container_width=True)

            ia_totals = ia_df["severity"].value_counts().reindex(
                IA_SEVERITY_ORDER, fill_value=0
            )
            st.caption(
                " · ".join(f"{sev}: {int(cnt)}" for sev, cnt in ia_totals.items())
            )
st.divider()

if not run:
    st.info("Select a month and click **Fetch & Calculate** to load KPIs.")
    st.stop()

if not jira_email or not jira_token:
    st.error("Jira credentials are required. Add them in the sidebar or .env file.")
    st.stop()

# ── Jira REST v3 client (requests-based, avoids deprecated v2 search) ─────────
import requests
from requests.auth import HTTPBasicAuth


def _jira_get(path: str, params: dict, email: str, token: str) -> dict:
    import time
    url = f"{JIRA_URL}/rest/api/3/{path}"
    auth = HTTPBasicAuth(email, token)
    headers = {"Accept": "application/json"}
    for attempt in range(4):
        try:
            resp = requests.get(url, params=params, auth=auth,
                                headers=headers, timeout=60)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)  # 1s, 2s, 4s


def _verify_jira(email: str, token: str):
    _jira_get("myself", {}, email, token)


try:
    _verify_jira(jira_email, jira_token)
except Exception as e:
    st.error(f"Jira connection failed: {e}")
    st.stop()


# ── Jira data fetching ─────────────────────────────────────────────────────────
STAGE_WORKSPACE_ID = "fc5b8d6f-f02e-4202-806d-1d41c9779519"


def _jql_paginate(jql: str, fields: str, email: str, token: str) -> List[dict]:
    """Fetch all pages for a JQL query, return list of issue dicts."""
    tickets = []
    next_page_token = None
    page_size = 50
    while True:
        params = {
            "jql": jql,
            "maxResults": page_size,
            "fields": fields,
            "expand": "changelog",
        }
        if next_page_token:
            params["nextPageToken"] = next_page_token
        data = _jira_get("search/jql", params, email, token)
        issues = data.get("issues", [])
        tickets.extend(issues)
        next_page_token = data.get("nextPageToken")
        if not next_page_token or len(issues) < page_size:
            break
    return tickets


@st.cache_data(ttl=300, show_spinner=False)
def discover_stage_ari(start: str, end: str, _email: str, _token: str) -> Optional[str]:
    """
    Find the Stage ARI used by EA tickets created in the given month.
    The Stage field is how the TEO team groups tickets by period — it's more
    accurate than filtering by created date.
    Returns the ARI string (e.g. "ari:cloud:cmdb::object/<ws>/<id>") or None.
    """
    jql = (
        f'project = "{GM_PROJECT}" AND issuetype = "{EA_ISSUE_TYPE}" '
        f'{_ea_label_clause()}'
        f'AND created >= "{start}" AND created <= "{end}" '
        f'AND "Stage" is not EMPTY ORDER BY created DESC'
    )
    params = {
        "jql": jql,
        "maxResults": 20,
        "fields": "customfield_10121",
    }
    data = _jira_get("search/jql", params, _email, _token)
    counts: dict[str, int] = {}
    for issue in data.get("issues", []):
        stages = issue.get("fields", {}).get("customfield_10121") or []
        for s in stages:
            obj_id = s.get("objectId") or s.get("id", "").split(":")[-1]
            if obj_id:
                ari = f"ari:cloud:cmdb::object/{STAGE_WORKSPACE_ID}/{obj_id}"
                counts[ari] = counts.get(ari, 0) + 1
    return max(counts, key=counts.get) if counts else None


@st.cache_data(ttl=300, show_spinner=False)
def fetch_ea_tickets_by_stage(
    stage_ari: str, start: str, end: str, _email: str, _token: str
) -> List[dict]:
    """Fetch EA tickets for a given Stage ARI, bounded to the period's created
    date range — the Stage/Production clause alone matches EVERY Production
    EA ever created (not just this period), so without the date bound this
    pulls the entire historical set."""
    jql = (
        f'project = "{GM_PROJECT}" AND issuetype = "{EA_ISSUE_TYPE}" '
        f'{_ea_label_clause()}'
        f'AND (cf[10689] = "Production" OR cf[10121] = "{stage_ari}") '
        f'AND created >= "{start}" AND created <= "{end}" ORDER BY created ASC'
    )
    return _jql_paginate(
        jql, "summary,status,resolution,labels,issuelinks,created,customfield_10121,customfield_10620",
        _email, _token,
    )


@st.cache_data(ttl=300, show_spinner=False)
def fetch_ea_tickets_by_date(start: str, end: str, _email: str, _token: str) -> List[dict]:
    """Fallback: fetch EA tickets by created date when no Stage is detected."""
    jql = (
        f'project = "{GM_PROJECT}" AND issuetype = "{EA_ISSUE_TYPE}" '
        f'{_ea_label_clause()}'
        f'AND created >= "{start}" AND created <= "{end}" ORDER BY created ASC'
    )
    return _jql_paginate(
        jql, "summary,status,resolution,labels,issuelinks,created,customfield_10121,customfield_10620",
        _email, _token,
    )


@st.cache_data(ttl=300, show_spinner=False)
def fetch_teo_filter_keys(start: str, _email: str, _token: str) -> set:
    """
    Return the set of GM keys matching the TEO filter for the given period
    start date:
        project = GM AND type = "Engineering Analysis"
        AND "Resolved By[User Picker (single user)]" in (currentUser(), <other>)
        AND createdDate >= '{start}'
        AND (cf[10689] = "Production" OR cf[10121] = "<TEO stage ARI>")
        AND status in (Done, "Unable to Conclude", "No longer an issue")
    Used to exclude TEO-resolved EAs from the Ticket → QA numerator.
    """
    jql = (
        f'project = "{GM_PROJECT}" '
        f'AND issuetype = "{EA_ISSUE_TYPE}" '
        f'AND "Resolved By[User Picker (single user)]" in ({TEO_RESOLVED_BY_USERS_JQL}) '
        f'AND createdDate >= "{start}" '
        f'AND (cf[10689] = "Production" OR cf[10121] = "{TEO_STAGE_ARI}") '
        f'AND status in ({TEO_FILTER_STATUSES_JQL})'
    )
    issues = _jql_paginate(jql, "summary", _email, _token)
    return {i.get("key", "") for i in issues if i.get("key")}


@st.cache_data(ttl=300, show_spinner=False)
def fetch_gm_tickets_by_keys(keys: tuple, _email: str, _token: str) -> List[dict]:
    """
    Fetch arbitrary GM issues by key (chunked in batches of 100 to stay
    inside Jira's IN-clause limits). Used to enrich SF-linked GM tickets
    that fall outside the period's EA fetch.
    """
    if not keys:
        return []
    out: List[dict] = []
    keys_list = list(keys)
    for i in range(0, len(keys_list), 100):
        batch = keys_list[i:i + 100]
        in_clause = ",".join(f'"{k}"' for k in batch)
        jql = f"key in ({in_clause})"
        out.extend(_jql_paginate(
            jql, "summary,status,resolution,labels,issuelinks,created,issuetype,customfield_10620",
            _email, _token,
        ))
    return out


SF_CASE_FIELDS = [
    "Id", "CaseNumber", "Subject", "Type", "Status", "IsClosed", "IsEscalated",
    "CreatedDate", "ClosedDate",
    "Jira_Ticket_Id__c", "Jira_Ticket_URL__c", "Jira_Severity__c",
    "Jira_Project__c", "GM_Team__c", "GM_Origins__c", "Product_Type__c",
    "Account_Name__c", "First_Response_Time__c",
    # Case category — Incidents that aren't `Software` are dropped from scope.
    "Category__c",
    # Real severity field on the Case object (values: Severity 1..4). The
    # multiselect filter binds to this field, not `Jira_Severity__c`.
    "SLA_Category__c",
]

# Only Software-category SF Incidents are in scope for TEO KPIs.
SF_CASE_CATEGORY = "Software"



def _query_sf(soql: str, access_token: str, inst_url: str) -> list:
    """Run a SOQL query with pagination. Returns list of records."""
    import requests as req_lib
    scheme = "OAuth" if "!" in access_token else "Bearer"
    headers = {"Authorization": f"{scheme} {access_token}"}
    records: list = []
    url = f"{inst_url}/services/data/v60.0/query"
    params = {"q": soql}
    while True:
        r = req_lib.get(url, headers=headers, params=params, timeout=60)
        r.raise_for_status()
        result = r.json()
        records.extend(result.get("records", []))
        if result.get("done"):
            break
        url = f"{inst_url}{result.get('nextRecordsUrl', '')}"
        params = {}
    return records


@st.cache_data(ttl=300, show_spinner=False)
def sf_oauth_client_credentials_token() -> Optional[dict]:
    """
    Server-deploy fallback when no `sf` CLI is available: exchanges
    SF_CLIENT_ID + SF_CLIENT_SECRET (from .env) for a short-lived access
    token via the OAuth2 client_credentials grant. Returns
    {"access_token", "instance_url"} or None if creds aren't set or the
    exchange fails.
    """
    import requests as _req
    client_id     = os.getenv("SF_CLIENT_ID", "").strip()
    client_secret = os.getenv("SF_CLIENT_SECRET", "").strip()
    instance_url  = os.getenv("SF_INSTANCE_URL", "").strip().rstrip("/")
    if not (client_id and client_secret and instance_url):
        return None
    try:
        resp = _req.post(
            f"{instance_url}/services/oauth2/token",
            data={
                "grant_type":    "client_credentials",
                "client_id":     client_id,
                "client_secret": client_secret,
            },
            timeout=20,
        )
        if resp.status_code != 200:
            return None
        body = resp.json()
        if not body.get("access_token"):
            return None
        return {
            "access_token": body["access_token"],
            "instance_url": body.get("instance_url", instance_url).rstrip("/"),
        }
    except Exception:
        return None


@st.cache_data(ttl=300, show_spinner=False)
def fetch_sf_cases(start: str, end: str, _alias: str,
                   _session_id: str, _instance_url: str) -> list:
    """
    Fetch SF cases created in [start, end]. Auth precedence:
        1. SF CLI session (`sf org display --json`)
        2. OAuth2 client_credentials (SF_CLIENT_ID + SF_CLIENT_SECRET in .env)
        3. Manual session ID + instance URL from the sidebar fallback
    """
    fields_clause = ", ".join(SF_CASE_FIELDS)
    types_clause = ", ".join(f"'{t}'" for t in SF_CASE_TYPES)
    products_clause = ", ".join(f"'{p}'" for p in SF_PRODUCT_TYPES)
    # IST-aligned bounds: SOQL DateTime literals carry an explicit offset so
    # Salesforce evaluates the window in IST rather than the org default UTC.
    # `start` and `end` are date strings (YYYY-MM-DD) from the period picker.
    soql = (
        f"SELECT {fields_clause} FROM Case "
        f"WHERE CreatedDate >= {start}T00:00:00+05:30 "
        f"AND CreatedDate <= {end}T23:59:59+05:30 "
        f"AND Type IN ({types_clause}) "
        f"AND Product_Type__c IN ({products_clause}) "
        f"AND Category__c = '{SF_CASE_CATEGORY}'"
    )
    cli = sf_cli_session(_alias)
    if cli:
        return _query_sf(soql, cli["access_token"], cli["instance_url"])
    oauth = sf_oauth_client_credentials_token()
    if oauth:
        return _query_sf(soql, oauth["access_token"], oauth["instance_url"])
    if _session_id and _instance_url:
        return _query_sf(soql, _session_id, _instance_url.rstrip("/"))
    raise RuntimeError(
        "Salesforce not authenticated. Either (a) `sf org login web --alias "
        f"{_alias}` locally, (b) set SF_CLIENT_ID + SF_CLIENT_SECRET + "
        "SF_INSTANCE_URL in .env for OAuth2 client_credentials, or (c) "
        "paste a session ID in the sidebar."
    )


_GM_KEY_RE = re.compile(r"\b(GM-\d+)\b", re.IGNORECASE)


def case_linked_gm_key(case: dict) -> Optional[str]:
    """Extract the GM-XXXX key a case points to, via Jira_Ticket_Id__c or URL."""
    for field in ("Jira_Ticket_Id__c", "Jira_Ticket_URL__c"):
        val = case.get(field)
        if val:
            m = _GM_KEY_RE.search(str(val))
            if m:
                return m.group(1).upper()
    return None


# ── Analysis helpers (work on plain dicts from REST v3) ────────────────────────
def ticket_reached_qa(ticket: dict) -> bool:
    """
    True if the ticket is currently sitting in a QA status, ever transitioned
    into one, or ever transitioned out of one — the last case catches tickets
    created directly at a QA status, since Jira's changelog never records the
    initial status as a transition, only later changes to it.
    """
    if get_status(ticket) in QA_STATUSES:
        return True
    for history in ticket.get("changelog", {}).get("histories", []):
        for item in history.get("items", []):
            if item.get("field") == "status" and (
                item.get("toString") in QA_STATUSES or item.get("fromString") in QA_STATUSES
            ):
                return True
    return False


def _linked_bugs(ticket: dict) -> List[str]:
    bugs = []
    for link in ticket.get("fields", {}).get("issuelinks", []):
        for side in ("outwardIssue", "inwardIssue"):
            linked = link.get(side)
            if linked:
                itype = linked.get("fields", {}).get("issuetype", {}).get("name", "")
                if itype == BUG_ISSUE_TYPE:
                    bugs.append(linked.get("key", ""))
    return bugs


def get_linked_ea_keys(ticket: dict) -> List[str]:
    """Keys of linked issues that are themselves an Engineering Analysis —
    used to chase a 'Duplicate' resolution back to its original EA."""
    keys = []
    for link in ticket.get("fields", {}).get("issuelinks", []):
        for side in ("outwardIssue", "inwardIssue"):
            linked = link.get(side)
            if linked:
                itype = linked.get("fields", {}).get("issuetype", {}).get("name", "")
                if itype == EA_ISSUE_TYPE:
                    k = linked.get("key", "")
                    if k:
                        keys.append(k)
    return keys


def ticket_has_linked_bug(ticket: dict) -> bool:
    """
    Did this EA ticket conclude as a bug outcome?
    Strict definition (per spec): resolution ∈ BUG_RESOLUTIONS.
    No linked-Bug-issue fallback — only concluded EAs with a bug resolution count.
    """
    return get_resolution(ticket) in BUG_RESOLUTIONS


def ticket_is_in_progress(ticket: dict) -> bool:
    """Current Jira status indicates the EA is still being actively worked on."""
    return get_status(ticket) in IN_PROGRESS_STATUSES


def ticket_is_concluded(ticket: dict) -> bool:
    """Jira status is Done (with any resolution)."""
    return get_status(ticket) == CONCLUDED_STATUS


def ticket_is_concluded_v2(ticket: dict) -> bool:
    """
    Overview-sheet definition: 'concluded' = status ∈
    {Done, No longer an issue, Unable to Conclude}. Used by the bucket cards
    and the Ticket → QA [In Progress] KPI per the v2 spec.
    """
    return get_status(ticket) in CONCLUDED_STATUSES


def ticket_reached_qa_in_progress(ticket: dict) -> bool:
    """
    Did the EA ever transition to 'QA analysis in progress' status?
    (Stricter than ticket_reached_qa which also accepts 'Queued for QA analysis'.)
    """
    if get_status(ticket) == QA_IN_PROGRESS_STATUS:
        return True
    for h in ticket.get("changelog", {}).get("histories", []):
        for it in h.get("items", []):
            if it.get("field") == "status" and (
                it.get("toString") == QA_IN_PROGRESS_STATUS or it.get("fromString") == QA_IN_PROGRESS_STATUS
            ):
                return True
    return False


def ticket_has_ea_bug_kpi_resolution(ticket: dict) -> bool:
    """Resolution ∈ {Known Bug, New Bug} — strict EA → Bug numerator."""
    return get_resolution(ticket) in EA_BUG_KPI_RESOLUTIONS


def ticket_has_pg_resolution(ticket: dict) -> bool:
    """Resolution ∈ PROCESS_GAP_RESOLUTIONS — EA → PG numerator (direct match only)."""
    return get_resolution(ticket) in PROCESS_GAP_RESOLUTIONS


def get_linked_bugs(ticket: dict) -> List[str]:
    return _linked_bugs(ticket)


def get_resolution(ticket: dict) -> str:
    r = ticket.get("fields", {}).get("resolution")
    return r.get("name", "") if r else ""


def get_status(ticket: dict) -> str:
    return (ticket.get("fields", {}).get("status") or {}).get("name", "")


def get_labels(ticket: dict) -> List[str]:
    return ticket.get("fields", {}).get("labels", []) or []


def get_gm_origins(ticket: dict) -> List[str]:
    """
    Pull the GM Origins multi-select picklist (Jira `customfield_10620`) for
    an EA ticket. Returns a list of origin display values like
    ['Walmart Mexico', 'Aritzia']. Empty list if unset.
    """
    raw = ticket.get("fields", {}).get("customfield_10620") or []
    out: List[str] = []
    for entry in raw:
        if isinstance(entry, dict):
            v = entry.get("value") or ""
        else:
            v = str(entry or "")
        v = v.strip()
        if v:
            out.append(v)
    return out


# ── Load data ──────────────────────────────────────────────────────────────────
start_str = range_start.strftime("%Y-%m-%d")
end_str = range_end.strftime("%Y-%m-%d")

# Strict period boundaries in IST (+05:30). The team's Jira profile timezone is
# IST, the Salesforce data sheet was generated in IST, and operationally the
# month boundary is "00:00 IST" — so we re-filter every fetched ticket against
# IST bounds. This brings dashboard numbers in line with the Overview tab.
from datetime import timedelta, timezone as _tz
IST = _tz(timedelta(hours=5, minutes=30), name="IST")
_period_start_ist = datetime.combine(range_start, datetime.min.time(), tzinfo=IST)
_period_end_ist   = (datetime.combine(range_end, datetime.min.time(), tzinfo=IST)
                     + timedelta(days=1))


def _ticket_in_period_ist(ticket: dict) -> bool:
    """True iff ticket.created (converted to IST) is in [period_start, period_end)."""
    created = ticket.get("fields", {}).get("created")
    if not created:
        return False
    try:
        # ISO format like '2026-05-01T05:12:41.011+0530' — fromisoformat handles
        # numeric offsets natively in py3.11+; for 3.9, normalize manually.
        s = created
        # Convert '+HHMM' / '-HHMM' to '+HH:MM' for older Python
        if len(s) >= 5 and (s[-5] in "+-") and s[-3] != ":":
            s = s[:-2] + ":" + s[-2:]
        ts = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return False
    return _period_start_ist <= ts.astimezone(IST) < _period_end_ist


with st.spinner(f"Fetching GM Engineering Analysis tickets for {period_label}…"):
    try:
        _stage_ari = discover_stage_ari(start_str, end_str, jira_email, jira_token)
        if _stage_ari:
            _ea_raw = fetch_ea_tickets_by_stage(
                _stage_ari, start_str, end_str, jira_email, jira_token
            )
        else:
            st.caption(
                "ℹ️ No Stage ARI detected for this period — falling back to "
                "plain created-date filter (may over-count vs the Stage-scoped view)."
            )
            _ea_raw = fetch_ea_tickets_by_date(start_str, end_str, jira_email, jira_token)
    except Exception as e:
        st.error(f"Failed to fetch Jira tickets: {e}")
        st.stop()

# Apply strict IST-bounded re-filter to drop tickets that slipped in due to
# timezone differences between the Jira-profile filter and the period definition.
ea_tickets = [t for t in _ea_raw if _ticket_in_period_ist(t)]
_dropped = len(_ea_raw) - len(ea_tickets)
if _dropped:
    st.caption(
        f"ℹ️  {_dropped} EA ticket(s) returned by Jira fell outside the strict "
        f"IST period [{range_start} 00:00 IST, "
        f"{range_end + timedelta(days=1)} 00:00 IST) and were excluded."
    )

sf_cases_raw: list = []
sf_available = bool(_sf_cli) or bool(_sf_session_id) or (bool(os.getenv("SF_CLIENT_ID")) and bool(os.getenv("SF_CLIENT_SECRET")))
if sf_available:
    with st.spinner("Fetching Salesforce cases…"):
        try:
            sf_cases_raw = fetch_sf_cases(
                start_str, end_str, sf_alias,
                _sf_session_id, _sf_instance_url,
            )
        except RuntimeError as e:
            st.info(f"ℹ️ Salesforce KPIs unavailable: {e}")
            sf_available = False
        except Exception as e:
            st.warning(f"Salesforce fetch failed: {e}")
            sf_available = False

# ── Dashboard render fragment ───────────────────────────────────────────
# Wrapping pod filter + analysis + display in @st.fragment so widget
# interactions (pod change, CSV download) only re-run this block instead
# of the entire script. Outside-the-fragment state (Jira fetch, SF fetch,
# pod map) is read via closure and stays cached across re-runs.
@st.fragment
def render_dashboard():
    sf_cases = list(sf_cases_raw)

    # ── Pod filter ────────────────────────────────────────────────────────────────
    # Accounts are grouped into PODs (see POD_LIST_PATH). The dashboard exposes a
    # dropdown — default "All" leaves the data untouched; picking a pod restricts
    # SF cases to accounts whose name matches an entry in that pod's column.
    # Matching is fuzzy (lowercase, alphanumeric-only substring) so pod-list
    # "Ryder Maryland" picks up SF account "Ryder-Maryland(USA)".
    _ACCOUNT_FIELD = "Account_Name__c"
    _pod_map = load_pod_map(POD_LIST_PATH) if sf_available else {}
    selected_pod = "All"
    if sf_available and sf_cases:
        pod_options = ["All"] + list(_pod_map.keys()) if _pod_map else ["All"]
        selected_pod = st.selectbox(
            "Pod filter",
            options=pod_options,
            index=0,
            help=(
                "Filter SF cases by their assigned TEO pod. Account → pod mapping "
                f"comes from `{POD_LIST_PATH}`. **All** (default) shows every "
                "case; pick a pod to narrow. Matching is fuzzy substring "
                "(case + punctuation insensitive), so pod-list 'Ryder Maryland' "
                "catches SF account 'Ryder-Maryland(USA)'. Affects every SF-side "
                "KPI and chart."
            ),
        )
        if not _pod_map:
            st.caption(
                f"⚠ Pod list not found at `{POD_LIST_PATH}`. The dropdown is "
                f"showing only 'All'. Set `POD_LIST_PATH` env var or place the "
                f"Pod list.xlsx at the default location."
            )

        if selected_pod != "All":
            _pod_names = _pod_map.get(selected_pod, [])
            _lookup = _build_pod_lookup({selected_pod: _pod_names})
            before = len(sf_cases)
            sf_cases = [
                c for c in sf_cases
                if account_pod(c.get(_ACCOUNT_FIELD, ""), _lookup) == selected_pod
            ]
            # Show which SF accounts matched, for transparency
            matched_accounts = sorted({(c.get(_ACCOUNT_FIELD) or "") for c in sf_cases})
            st.caption(
                f"🔎 **Pod filter active:** `{selected_pod}` — "
                f"{len(sf_cases)}/{before} SF cases match. "
                f"Matched accounts: {', '.join(matched_accounts) if matched_accounts else '(none)'}"
            )

    # ── Salesforce severity filter (multiselect, dynamic) ────────────────────
    # Reads `SLA_Category__c` on the Case object (values: "Severity 1" …
    # "Severity 4"). Lives inside the fragment so changes don't trigger a
    # full script rerun — Jira/SF fetches stay cached, only analysis +
    # display refreshes.
    SF_SEVERITIES = ["Severity 1", "Severity 2", "Severity 3", "Severity 4"]
    selected_severities = st.multiselect(
        "Salesforce severity",
        options=SF_SEVERITIES,
        default=SF_SEVERITIES,
        help=(
            "Filter SF cases by their `SLA_Category__c` value. Default is "
            "all four severities. Empty selection is treated as **all** "
            "(won't zero out the dashboard). Affects every downstream metric "
            "and chart — cascades through the EA-side counts because EAs are "
            "only counted when linked from at least one in-scope SF case."
        ),
    )
    _effective_severities = (
        set(selected_severities) if selected_severities else set(SF_SEVERITIES)
    )
    # Always apply the filter — when the user has all 4 selected, the
    # _effective_severities set equals every legal value, so the comprehension
    # is a no-op. Conditionally skipping the filter caused a race-y bug where
    # deselecting one severity didn't actually drop those cases.
    if sf_available and sf_cases:
        before_sev = len(sf_cases)
        sf_cases = [
            c for c in sf_cases
            if (c.get("SLA_Category__c") or "") in _effective_severities
        ]
        if len(sf_cases) < before_sev:
            st.caption(
                f"🔎 **Severity filter active:** "
                f"{', '.join(sorted(_effective_severities))} — "
                f"{len(sf_cases)}/{before_sev} SF cases match."
            )

    # ── Compute KPIs ───────────────────────────────────────────────────────────────
    total_ea = len(ea_tickets)

    # Per-EA status lookup, keyed by GM key. Built ONLY from EAs created in the
    # selected period — no out-of-period enrichment. This is what gates the SF-side
    # KPIs to "linked GM was created in selected month" (de-duplicates across months).
    gm_status: dict[str, dict] = {}

    # ── EA → Bug: follow "Duplicate" resolutions to their linked EA(s) ────────
    # A ticket resolved as Duplicate carries no bug signal of its own — chase
    # its EA-type issuelinks and inherit New Bug / Known Bug from whichever
    # linked EA it points to (which may itself be another Duplicate hop).
    # Seed the lookup from the already-fetched period EAs, then breadth-first
    # fetch any linked EA keys we don't have yet (capped at 5 hops to bound
    # pathological link cycles).
    _dup_res_lookup: dict[str, str] = {}
    _dup_links_lookup: dict[str, list] = {}
    _dup_bugs_lookup: dict[str, list] = {}
    for _t in ea_tickets:
        _k = _t.get("key", "")
        if _k:
            _dup_res_lookup[_k] = get_resolution(_t)
            _dup_links_lookup[_k] = get_linked_ea_keys(_t)
            _dup_bugs_lookup[_k] = get_linked_bugs(_t)

    _dup_frontier = {
        lk for k, r in _dup_res_lookup.items() if r == DUPLICATE_RESOLUTION
        for lk in _dup_links_lookup.get(k, []) if lk not in _dup_res_lookup
    }
    _dup_hops = 0
    while _dup_frontier and _dup_hops < 5:
        _dup_hops += 1
        try:
            _dup_extra = fetch_gm_tickets_by_keys(
                tuple(sorted(_dup_frontier)), jira_email, jira_token,
            )
        except Exception as e:
            st.warning(f"Could not resolve Duplicate-linked EAs: {e}")
            break
        _dup_frontier = set()
        for _t in _dup_extra:
            _k = _t.get("key", "")
            if not _k or _k in _dup_res_lookup:
                continue
            _dup_res_lookup[_k] = get_resolution(_t)
            _dup_links_lookup[_k] = get_linked_ea_keys(_t)
            _dup_bugs_lookup[_k] = get_linked_bugs(_t)
            if _dup_res_lookup[_k] == DUPLICATE_RESOLUTION:
                _dup_frontier |= {
                    lk for lk in _dup_links_lookup[_k] if lk not in _dup_res_lookup
                }

    def _dup_target_is_bug(key: str, _visited: set) -> bool:
        """Would `key` count as a bug outcome if something duplicates into it?
        True if it resolved Known/New Bug, OR it has a Bug-type issue linked
        to it directly (regardless of its own resolution), OR — if it's
        itself a Duplicate — one of ITS targets satisfies either."""
        if not key or key in _visited:
            return False
        _visited.add(key)
        res = _dup_res_lookup.get(key, "")
        if res in EA_BUG_KPI_RESOLUTIONS:
            return True
        if _dup_bugs_lookup.get(key):
            return True
        if res == DUPLICATE_RESOLUTION:
            return any(
                _dup_target_is_bug(lk, _visited)
                for lk in _dup_links_lookup.get(key, [])
            )
        return False

    def _resolves_to_kpi_bug(key: str) -> bool:
        """True if `key` resolved Known/New Bug directly, or — if it's a
        Duplicate — EITHER it has a Bug-type issue linked to itself
        directly (no EA hop needed) OR it chases to a linked EA (through
        further Duplicate hops) that resolved Known/New Bug or has a
        Bug-type issue linked to it. Delegates to `_dup_target_is_bug`,
        which checks exactly that (own resolution, own linked-bug, then
        recurse through Duplicate links) — called on `key` itself so the
        Duplicate ticket's OWN direct Bug link isn't skipped."""
        res = _dup_res_lookup.get(key, "")
        if res in EA_BUG_KPI_RESOLUTIONS:
            return True
        if res == DUPLICATE_RESOLUTION:
            return _dup_target_is_bug(key, set())
        return False

    rows = []
    for t in ea_tickets:
        fields = t.get("fields", {})
        key = t.get("key", "")
        reached_qa = ticket_reached_qa(t)
        reached_qa_ip = ticket_reached_qa_in_progress(t)
        has_bug = ticket_has_linked_bug(t)
        has_strict_bug = get_resolution(t) in STRICT_BUG_RESOLUTIONS
        has_kpi_bug = _resolves_to_kpi_bug(key) if key else ticket_has_ea_bug_kpi_resolution(t)
        has_pg = ticket_has_pg_resolution(t)
        bug_keys = get_linked_bugs(t)
        resolution = get_resolution(t)
        labels = get_labels(t)
        status_name = get_status(t)
        is_concluded = ticket_is_concluded(t)
        is_concluded_v2 = ticket_is_concluded_v2(t)
        is_in_progress = ticket_is_in_progress(t)
        gm_origins = get_gm_origins(t)
        if key:
            gm_status[key] = {
                "reached_qa": reached_qa,
                "reached_qa_ip": reached_qa_ip,
                "has_bug": has_bug,
                "has_strict_bug": has_strict_bug,
                "has_kpi_bug": has_kpi_bug,
                "has_pg": has_pg,
                "status": status_name,
                "resolution": resolution,
                "is_concluded": is_concluded,
                "is_concluded_v2": is_concluded_v2,
                "is_in_progress": is_in_progress,
                "teo_reviewed": any(l in labels for l in TEO_LABELS),
                "gm_origins": gm_origins,
            }
        rows.append(
            {
                "key": key,
                "summary": fields.get("summary", ""),
                "status": status_name,
                "resolution": resolution,
                "teo_reviewed": any(l in labels for l in TEO_LABELS),
                "reached_qa": reached_qa,
                "reached_qa_ip": reached_qa_ip,
                "has_bug": has_bug,
                "has_strict_bug": has_strict_bug,
                "has_kpi_bug": has_kpi_bug,
                "has_pg": has_pg,
                "is_concluded": is_concluded,
                "is_concluded_v2": is_concluded_v2,
                "is_in_progress": is_in_progress,
                "gm_origins": gm_origins,
                "bug_keys": ", ".join(bug_keys),
            }
        )

    df = pd.DataFrame(rows)

    ea_reached_qa = int(df["reached_qa"].sum()) if not df.empty else 0
    ea_with_bug = int(df["has_bug"].sum()) if not df.empty else 0
    # Strict-bug variant — used by the SF/EA funnels and TEO leakage. Narrower set
    # (New Bug, Known Bug, Missed Checkin) than the regular KPI 3 numerator.
    ea_with_strict_bug = int(df["has_strict_bug"].sum()) if not df.empty else 0
    ea_in_progress_count = int(df["is_in_progress"].sum()) if not df.empty else 0
    ea_concluded_count = int(df["is_concluded"].sum()) if not df.empty else 0
    # For KPI 3 (EA → Bug) we restrict to EAs whose QA cycle has *concluded* —
    # i.e., reached a QA status AND now Done. In-progress GMs that may yet flip
    # to a bug resolution are excluded from both numerator and denominator so
    # the ratio reflects completed analysis only.
    ea_qa_concluded = int(((df["reached_qa"]) & (df["is_concluded"])).sum()) \
        if not df.empty else 0
    ea_bug_after_qa = int(((df["reached_qa"]) & (df["has_bug"])).sum()) \
        if not df.empty else 0
    ea_strict_bug_after_qa = int(((df["reached_qa"]) & (df["has_strict_bug"])).sum()) \
        if not df.empty else 0
    teo_reviewed_count = int(df["teo_reviewed"].sum()) if not df.empty else 0

    # ── Salesforce-side KPIs ───────────────────────────────────────────────────────
    # All Ticket→* KPIs are now period-strict: only count SF cases whose linked GM
    # EA was created in the selected month (i.e., the GM key appears in gm_status,
    # which only contains in-period EAs).
    kpi1 = None
    total_sf = len(sf_cases)
    sf_linked_to_gm = 0          # KPI 1 numerator (linked & GM in period)
    sf_any_gm_link = 0           # SF cases with ANY GM link (regardless of EA date)
    sf_qa_concluded = 0          # KPI 2 numerator
    sf_qa_in_progress = 0        # KPI 2b numerator
    sf_with_bug = 0              # KPI 4 numerator (broad bug set)
    sf_with_strict_bug = 0       # SF Case Flow funnel final stage (strict bug set)
    sf_reached_qa = 0            # SF cases whose in-period GM reached QA
    sf_escalated = 0
    sf_closed = 0
    mttr_hours_mean: Optional[float] = None
    mttr_hours_median: Optional[float] = None
    sf_df = pd.DataFrame()
    all_linked_keys_from_sf: set[str] = set()

    if sf_available and total_sf:
        sf_rows = []
        for c in sf_cases:
            gm_key = case_linked_gm_key(c)
            # period-strict: only honour the link if GM was created in selected month
            gm_in_period = bool(gm_key and gm_key in gm_status)
            gm_info = gm_status.get(gm_key, {}) if gm_in_period else {}
            if gm_key:
                all_linked_keys_from_sf.add(gm_key)
            created = c.get("CreatedDate")
            closed = c.get("ClosedDate")
            resolve_hrs: Optional[float] = None
            if created and closed:
                try:
                    t0 = datetime.fromisoformat(created.replace("Z", "+00:00"))
                    t1 = datetime.fromisoformat(closed.replace("Z", "+00:00"))
                    resolve_hrs = (t1 - t0).total_seconds() / 3600.0
                except Exception:
                    resolve_hrs = None
            sf_rows.append({
                "case_number": c.get("CaseNumber", ""),
                "type": c.get("Type") or "Unspecified",
                "status": c.get("Status", ""),
                "is_closed": bool(c.get("IsClosed")),
                "is_escalated": bool(c.get("IsEscalated")),
                # gm_key_raw — the actual extracted GM regardless of period
                "gm_key_raw": gm_key or "",
                # gm_key only kept when the GM is in-period; out-of-period links blanked
                "gm_key": gm_key if gm_in_period else "",
                "gm_status": gm_info.get("status", ""),
                "gm_reached_qa": bool(gm_info.get("reached_qa")),
                "gm_reached_qa_ip": bool(gm_info.get("reached_qa_ip")),
                "gm_has_bug": bool(gm_info.get("has_bug")),
                "gm_has_strict_bug": bool(gm_info.get("has_strict_bug")),
                "gm_has_kpi_bug": bool(gm_info.get("has_kpi_bug")),
                "gm_is_concluded": bool(gm_info.get("is_concluded")),
                "gm_is_concluded_v2": bool(gm_info.get("is_concluded_v2")),
                "gm_is_in_progress": bool(gm_info.get("is_in_progress")),
                "gm_teo_reviewed": bool(gm_info.get("teo_reviewed")),
                "severity": c.get("Jira_Severity__c") or "Unspecified",
                "gm_team": c.get("GM_Team__c") or "Unassigned",
                "gm_origin": c.get("GM_Origins__c") or "Unspecified",
                "product": c.get("Product_Type__c") or "Unspecified",
                "account": c.get("Account_Name__c") or "Unknown",
                "resolve_hours": resolve_hrs,
            })
        sf_df = pd.DataFrame(sf_rows)

        # KPI counts — all gated on gm_key ≠ "" (i.e., linked-and-in-period).
        # Ticket → QA / [In Progress] follow the Overview-sheet spec:
        #   • Ticket → QA: linked + EA reached "QA analysis in progress" status
        #   • Ticket → QA [In Progress]: linked + EA's current status NOT in
        #     {Done, No longer an issue, Unable to Conclude}
        linked_mask = sf_df["gm_key"] != ""
        sf_any_gm_link = int((sf_df["gm_key_raw"] != "").sum())
        sf_linked_to_gm = int(linked_mask.sum())
        sf_qa_concluded = int((linked_mask & sf_df["gm_reached_qa_ip"]).sum())
        sf_qa_in_progress = int(
            (linked_mask & ~sf_df["gm_is_concluded_v2"]).sum()
        )
        sf_with_bug = int(sf_df["gm_has_bug"].sum())
        sf_with_strict_bug = int(sf_df["gm_has_strict_bug"].sum())
        sf_reached_qa = int((linked_mask & sf_df["gm_reached_qa"]).sum())
        sf_escalated = int(sf_df["is_escalated"].sum())
        sf_closed = int(sf_df["is_closed"].sum())
        closed_hrs = sf_df.loc[sf_df["is_closed"], "resolve_hours"].dropna()
        if not closed_hrs.empty:
            mttr_hours_mean = float(closed_hrs.mean())
            mttr_hours_median = float(closed_hrs.median())

        kpi1 = sf_linked_to_gm / total_sf if total_sf else 0

    # Snapshot the in-period EA set BEFORE we enrich gm_status with
    # out-of-period linked EAs (needed below for the bucket card split and
    # for EA → Bug denominator).
    in_period_ea_keys: set[str] = set(gm_status.keys())
    ea_in_period_linked_to_sf = len(in_period_ea_keys & all_linked_keys_from_sf)

    # ── Enrich gm_status with linked EAs that fall OUTSIDE the period ─────────
    # The bucket cards "EAs Concluded" and "EAs In Progress" need status info
    # for every unique linked EA (the C8/C9 cells in the Overview sheet) —
    # including ones created before/after the selected month. We only fetch
    # the keys that aren't already in gm_status.
    missing_linked_keys = tuple(
        sorted(all_linked_keys_from_sf - in_period_ea_keys)
    )
    if missing_linked_keys and jira_email and jira_token:
        with st.spinner(
            f"Enriching {len(missing_linked_keys)} out-of-period linked EAs…"
        ):
            try:
                extra = fetch_gm_tickets_by_keys(
                    missing_linked_keys, jira_email, jira_token,
                )
            except Exception as e:
                st.warning(f"Could not enrich linked GM tickets: {e}")
                extra = []
        for t in extra:
            k = t.get("key", "")
            if k and k not in _dup_res_lookup:
                _dup_res_lookup[k] = get_resolution(t)
                _dup_links_lookup[k] = get_linked_ea_keys(t)
        for t in extra:
            k = t.get("key", "")
            if k:
                gm_status[k] = {
                    "reached_qa": ticket_reached_qa(t),
                    "reached_qa_ip": ticket_reached_qa_in_progress(t),
                    "has_bug": ticket_has_linked_bug(t),
                    "has_strict_bug": get_resolution(t) in STRICT_BUG_RESOLUTIONS,
                    "has_kpi_bug": _resolves_to_kpi_bug(k),
                    "status": get_status(t),
                    "resolution": get_resolution(t),
                    "is_concluded": ticket_is_concluded(t),
                    "is_concluded_v2": ticket_is_concluded_v2(t),
                    "is_in_progress": ticket_is_in_progress(t),
                    "teo_reviewed": any(l in get_labels(t) for l in TEO_LABELS),
                    "gm_origins": get_gm_origins(t),
                }

    # ── Old EAs (linked from SF in period, but EA itself was created earlier) ─
    old_ea_keys = all_linked_keys_from_sf - in_period_ea_keys
    in_period_linked_keys = in_period_ea_keys & all_linked_keys_from_sf

    # SF-side counts split by month/old
    sf_linked_to_old_eas = (
        int(sf_df["gm_key_raw"].isin(old_ea_keys).sum()) if not sf_df.empty else 0
    )

    # ── Status splits as SETS (so In Progress + Concluded == universe by
    #     construction; bucket cards display the sum to enforce this invariant). ──
    month_eas_concluded_keys = {
        k for k in in_period_ea_keys
        if gm_status.get(k, {}).get("is_concluded_v2")
    }
    month_eas_in_progress_keys = {
        k for k in in_period_ea_keys
        if k in gm_status and not gm_status[k].get("is_concluded_v2")
    }
    old_eas_concluded_keys = {
        k for k in old_ea_keys
        if gm_status.get(k, {}).get("is_concluded_v2")
    }
    old_eas_in_progress_keys = {
        k for k in old_ea_keys
        if k in gm_status and not gm_status[k].get("is_concluded_v2")
    }

    month_eas_concluded   = len(month_eas_concluded_keys)
    month_eas_in_progress = len(month_eas_in_progress_keys)
    old_eas_concluded     = len(old_eas_concluded_keys)
    old_eas_in_progress   = len(old_eas_in_progress_keys)

    # Old EAs displayed total = raw set-size so the bigger invariant holds:
    #     Month EAs + Old EAs == Unique EAs linked w/ SF.
    # If `In Progress + Concluded` is less than this (enrichment failed for
    # some keys), surface a small warning below the bucket row.
    old_eas_total_display = len(old_ea_keys)
    _old_ea_classified = old_eas_concluded + old_eas_in_progress

    # Legacy aggregates retained for code that reads them downstream
    linked_eas_concluded = month_eas_concluded + old_eas_concluded
    linked_eas_in_progress = month_eas_in_progress + old_eas_in_progress

    # ── TEO filter — EAs resolved by TEO users in the selected period ────────
    # The Ticket → QA numerator subtracts SF cases whose linked GM is in this
    # TEO-resolved set, on the assumption that TEO-owned closures don't count
    # as QA throughput.
    try:
        teo_filter_keys = fetch_teo_filter_keys(start_str, jira_email, jira_token)
    except Exception as e:
        st.warning(f"TEO-filter JQL failed: {e}")
        teo_filter_keys = set()

    # SF cases linked to a TEO-filter EA (subset of in-period linked SF cases)
    sf_linked_to_teo_filter = (
        int(sf_df["gm_key_raw"].isin(teo_filter_keys).sum())
        if not sf_df.empty else 0
    )

    # ── Three-way partition of Month EAs ──────────────────────────────────────
    # Per spec, Month EAs decompose into:
    #     In Progress  +  Month Concluded (QA-resolved only)  +  concluded from TEO
    # Remove TEO-resolved EAs from `month_eas_concluded_keys` so the QA-resolved
    # subset (used by EA → Bug and TEO Leakage) is correctly isolated.
    month_eas_concluded_keys = month_eas_concluded_keys - teo_filter_keys
    month_eas_concluded = len(month_eas_concluded_keys)
    # Re-derive the aggregate (used by SF Case Flow funnel etc.)
    linked_eas_concluded = month_eas_concluded + old_eas_concluded

    # ── "concluded from TEO" / "reached to QA" split of Month EAs ────────────
    #   concluded_from_teo = Month EAs that are in the TEO-resolved filter set.
    #   reached to QA      = Month EAs NOT in TEO filter (the QA-bound work
    #                        pool, regardless of whether the changelog
    #                        actually crossed `QA analysis in progress`). By
    #                        construction this equals
    #                        `Month In Progress + Month Concluded`.
    # `concluded_from_qa_keys` keeps the old variable name to minimise diff;
    # the card label now says "reached to QA".
    concluded_from_teo_keys = in_period_linked_keys & teo_filter_keys
    concluded_from_qa_keys  = in_period_linked_keys - teo_filter_keys

    ea_concluded_from_teo = len(concluded_from_teo_keys)
    ea_concluded_from_qa  = len(concluded_from_qa_keys)

    sf_concluded_from_teo = (
        int(sf_df["gm_key_raw"].isin(concluded_from_teo_keys).sum())
        if not sf_df.empty else 0
    )
    sf_concluded_from_qa = (
        int(sf_df["gm_key_raw"].isin(concluded_from_qa_keys).sum())
        if not sf_df.empty else 0
    )

    # Ticket → QA numerator: SF cases linked to a Month EA that is NOT in the
    # TEO-resolved filter set — same universe as the "EA reached to QA" card,
    # so the two SF counts match by construction. (The earlier `reached_qa_ip`
    # changelog gate was dropped per spec — it caused a 24-EA divergence in May
    # between Ticket → QA and the Month In Progress + Month Concluded sum.)
    if not sf_df.empty:
        in_qa_mask = (
            (sf_df["gm_key"] != "")
            & ~sf_df["gm_key_raw"].isin(teo_filter_keys)
        )
        sf_ticket_to_qa = int(in_qa_mask.sum())
        ticket_to_qa_keys = set(sf_df.loc[in_qa_mask, "gm_key_raw"])
    else:
        sf_ticket_to_qa = 0
        ticket_to_qa_keys = set()

    # EA → Bug (per new spec): of the MONTH EAS that concluded, how many
    # resolved as Known/New Bug?
    #   Numerator: month_eas_concluded_keys ∩ has_kpi_bug
    #   Denominator: month_eas_concluded
    ea_to_bug_keys = {
        k for k in month_eas_concluded_keys
        if gm_status.get(k, {}).get("has_kpi_bug")
    }
    ea_to_bug_num = len(ea_to_bug_keys)
    ea_to_bug_den = month_eas_concluded

    # Legacy variable kept for the existing EA → Bug download button
    ea_kpi_bug_count = ea_to_bug_num

    # EA → PG (Process Gaps): of the MONTH EAS that concluded, how many
    # resolved as a process/config gap rather than a product defect?
    # Direct resolution match only (see PROCESS_GAP_RESOLUTIONS) — no
    # Duplicate-chase, since a Duplicate carries no PG signal of its own.
    #   Numerator: month_eas_concluded_keys ∩ has_pg
    #   Denominator: month_eas_concluded
    ea_to_pg_keys = {
        k for k in month_eas_concluded_keys
        if gm_status.get(k, {}).get("has_pg")
    }
    ea_to_pg_num = len(ea_to_pg_keys)
    ea_to_pg_den = month_eas_concluded

    # EA → Improvements: union of Bug + PG outcomes — either one represents
    # an EA that surfaced an actionable improvement (product defect or
    # process/config gap), vs. closing as invalid/duplicate/no-issue/etc.
    #   Numerator: ea_to_bug_keys ∪ ea_to_pg_keys
    #   Denominator: month_eas_concluded
    ea_to_improvement_keys = ea_to_bug_keys | ea_to_pg_keys
    ea_to_improvement_num = len(ea_to_improvement_keys)
    ea_to_improvement_den = month_eas_concluded

    # ── Bug Rejection %: of the EAs DIRECTLY concluded as Known/New Bug
    # (own resolution field — excludes Duplicate-chased ones, since those
    # didn't themselves resolve as a bug), how many have a linked Bug-type
    # issue whose current status is "Rejected"? Needs the linked Bug
    # issues' own status, which isn't already fetched anywhere else — one
    # extra `key in (...)` lookup via the existing cached
    # `fetch_gm_tickets_by_keys` helper (same fetch path already used for
    # Duplicate-chase enrichment, not a new endpoint).
    _ea_ticket_by_key = {t.get("key", ""): t for t in ea_tickets if t.get("key")}
    _direct_bug_keys = {
        k for k in month_eas_concluded_keys
        if gm_status.get(k, {}).get("resolution") in EA_BUG_KPI_RESOLUTIONS
    }
    _linked_bug_keys_by_ea: dict[str, list] = {}
    for k in _direct_bug_keys:
        _t = _ea_ticket_by_key.get(k)
        if _t is not None:
            _linked_bug_keys_by_ea[k] = get_linked_bugs(_t)

    _all_linked_bug_keys = tuple(sorted({
        bk for bks in _linked_bug_keys_by_ea.values() for bk in bks
    }))
    try:
        _linked_bug_tickets = fetch_gm_tickets_by_keys(
            _all_linked_bug_keys, jira_email, jira_token,
        )
    except Exception as e:
        st.warning(f"Could not fetch linked Bug tickets for rejection check: {e}")
        _linked_bug_tickets = []
    _bug_status_lookup = {t.get("key", ""): get_status(t) for t in _linked_bug_tickets}

    bug_rejected_keys = {
        k for k, bks in _linked_bug_keys_by_ea.items()
        if any(_bug_status_lookup.get(bk) == BUG_REJECTED_STATUS for bk in bks)
    }
    bug_rejection_num = len(bug_rejected_keys)
    bug_rejection_den = len(_direct_bug_keys)
    bug_rejection_rate = (bug_rejection_num / bug_rejection_den) if bug_rejection_den else 0

    # ── KPIs ───────────────────────────────────────────────────────────────────
    if sf_available and total_sf:
        kpi1 = sf_any_gm_link / total_sf                  # Ticket → GM
        kpi_ticket_to_teo = sf_linked_to_gm / total_sf    # Ticket → TEO (new)
        kpi2 = sf_ticket_to_qa / total_sf                 # Ticket → QA (revised)
    else:
        kpi1 = None
        kpi_ticket_to_teo = None
        kpi2 = 0

    # EA → Bug (revised denominator)
    kpi3 = (ea_to_bug_num / ea_to_bug_den) if ea_to_bug_den else 0

    # EA → PG / EA → Improvements
    kpi_pg = (ea_to_pg_num / ea_to_pg_den) if ea_to_pg_den else 0
    kpi_improvement = (
        (ea_to_improvement_num / ea_to_improvement_den) if ea_to_improvement_den else 0
    )

    # ── Display ─────────────────────────────────────────────────────────────────────
    # CSS to fit 6 metric cards per row on standard screens — shrinks the value
    # font + tightens label + delta padding. Applies globally to all st.metric
    # widgets on this page (KPI strip and TEO Leakage strip get the same look).
    st.markdown(
        """
        <style>
          [data-testid="stMetric"] {
              padding: 4px 8px;
          }
          [data-testid="stMetricLabel"] p {
              font-size: 0.80rem !important;
              line-height: 1.1 !important;
          }
          [data-testid="stMetricValue"] {
              font-size: 1.35rem !important;
              line-height: 1.2 !important;
              white-space: nowrap;
              overflow: visible;
          }
          [data-testid="stMetricDelta"] {
              font-size: 0.75rem !important;
          }
        </style>
        """,
        unsafe_allow_html=True,
    )

    # ── Bucket row — row 1: 6 SF-focused cards, row 2: 4 EA status splits ─────
    st.subheader(f"Bucket Counts — {period_label}")

    # Same underlying counts as before — just reshaped into one table
    # (Bucket | SF Cases | GM Cases) instead of two rows of st.metric cards.
    # Ordered top-down as a funnel: total SF universe, any-GM-link subset,
    # split into Month vs Old EAs, Month EAs further split into TEO-closed
    # vs reached-to-QA, then the In Progress / Concluded status split for
    # each of Month and Old. Rows with no natural counterpart on one side
    # (e.g. Month/Old status splits have no distinct SF-side count) show "—".
    _bucket_rows = [
        ("Total SF Cases", total_sf, "—"),
        ("SF — Any GM link / Unique EAs", sf_any_gm_link, len(all_linked_keys_from_sf)),
        ("SF Linked w/ Month EAs / Month EAs", sf_linked_to_gm, ea_in_period_linked_to_sf),
        ("SF Cases / EA — concluded from TEO", sf_concluded_from_teo, ea_concluded_from_teo),
        ("SF Cases / EA reached to QA", sf_concluded_from_qa, ea_concluded_from_qa),
        ("Month EAs — In Progress", "—", month_eas_in_progress),
        ("Month EAs — Concluded", "—", month_eas_concluded),
        ("SF Linked w/ Old EAs / Old EAs", sf_linked_to_old_eas, old_eas_total_display),
        ("Old EAs — In Progress", "—", old_eas_in_progress),
        ("Old EAs — Concluded", "—", old_eas_concluded),
    ]
    _bucket_df = pd.DataFrame(
        [{"Bucket": b, "SF Cases": str(sf), "GM Cases": str(gm)} for b, sf, gm in _bucket_rows]
    )
    st.dataframe(_bucket_df, use_container_width=True, hide_index=True)

    with st.expander("What does each bucket row mean?"):
        st.markdown(
            "- **Total SF Cases** — SF cases created in the selected period "
            f"matching scope: Type ∈ {SF_CASE_TYPES} AND Product_Type__c ∈ "
            f"{SF_PRODUCT_TYPES}. Narrowed further by the active Pod/Severity filters.\n"
            "- **SF — Any GM link / Unique EAs** — SF: cases pointing to ANY "
            "GM-XXX regardless of when the EA was created. GM: distinct EA "
            "keys those cases point to (de-duplicated).\n"
            "- **SF Linked w/ Month EAs / Month EAs** — SF: cases whose linked "
            "EA was **created in this period** (IST). GM: distinct Month EAs "
            "= In Progress + Concluded.\n"
            "- **SF Cases / EA — concluded from TEO** — Of the Month EAs, the "
            "subset matching the TEO filter (resolved by TEO users + status ∈ "
            "{Done, Unable to Conclude, No longer an issue}). SF: cases linked "
            "to those EAs.\n"
            "- **SF Cases / EA reached to QA** — Month EAs NOT in the "
            "TEO-resolved filter set — the QA-bound work pool. By construction "
            "equals Month In Progress + Month Concluded. Broader than the "
            "Ticket → QA KPI numerator (that also requires a changelog "
            "transition to `QA analysis in progress`).\n"
            "- **Month EAs — In Progress / Concluded** — Status split of Month "
            "EAs (Concluded = Done/No longer an issue/Unable to Conclude, "
            "AND not TEO-resolved). Concluded is the **EA → Bug denominator** "
            "and the TEO Leakage universe.\n"
            "- **SF Linked w/ Old EAs / Old EAs** — SF: cases (in-period) "
            "whose linked EA was created OUTSIDE the period. GM: distinct Old "
            "EAs = Unique EAs linked w/ SF − Month EAs. By construction "
            "Month + Old = Unique.\n"
            "- **Old EAs — In Progress / Concluded** — Status split of Old EAs."
        )

    # Surface enrichment gaps (where Old In Progress + Old Concluded < Old EAs)
    if _old_ea_classified < old_eas_total_display:
        st.caption(
            f"⚠ {old_eas_total_display - _old_ea_classified} Old EA(s) "
            f"couldn't be classified into In Progress or Concluded — most "
            f"likely the Jira `key in (…)` enrichment couldn't fetch them "
            f"(deleted issues or permission-restricted). The bigger invariant "
            f"`Month + Old = Unique` still holds; the smaller "
            f"`Old In Progress + Old Concluded = Old EAs` doesn't."
        )

    st.divider()

    st.subheader(f"KPI Summary — {period_label}")

    # Card-style KPI display — replaces the flat st.metric row. Grouped into
    # two rows (Ticket Flow, then Bug Quality) so the layout reads as a
    # funnel instead of five same-weight boxes side by side. Streamlit theme
    # CSS variables (--secondary-background-color etc.) are used so cards
    # adapt to the viewer's light/dark theme automatically.
    st.markdown(
        """
        <style>
          .kpi-card {
              background: var(--secondary-background-color, rgba(128,128,128,0.08));
              border-radius: 14px;
              padding: 18px 22px 16px 22px;
              min-height: 138px;
              box-shadow: 0 1px 4px rgba(0,0,0,0.10);
          }
          .kpi-card-top { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
          .kpi-icon { font-size: 1.1rem; line-height:1; }
          .kpi-label { font-size: 0.76rem; font-weight:700; text-transform:uppercase;
                       letter-spacing:.05em; opacity:.68; }
          .kpi-value { font-size: 2.05rem; font-weight:750; line-height:1.05; margin-bottom:4px; }
          .kpi-sub { font-size: 0.82rem; opacity:.72; }
          .kpi-note { font-size: 0.76rem; margin-top:10px; padding-top:8px;
                      border-top:1px solid rgba(128,128,128,0.25); opacity:.85; }
          .kpi-section-header { font-size: 1.02rem; font-weight:700; margin: 2px 0 10px 0;
                                 opacity:.9; }
        </style>
        """,
        unsafe_allow_html=True,
    )

    def _kpi_card(icon: str, label: str, value: str, sub: str, accent: str,
                  note: str = "") -> None:
        note_html = f'<div class="kpi-note">{note}</div>' if note else ""
        st.markdown(
            f"""
            <div class="kpi-card" style="border-top: 4px solid {accent};">
              <div class="kpi-card-top">
                <span class="kpi-icon">{icon}</span>
                <span class="kpi-label">{label}</span>
              </div>
              <div class="kpi-value" style="color:{accent};">{value}</div>
              <div class="kpi-sub">{sub}</div>
              {note_html}
            </div>
            """,
            unsafe_allow_html=True,
        )

    def _section_header(text: str) -> None:
        st.markdown(f'<div class="kpi-section-header">{text}</div>', unsafe_allow_html=True)


    def _bucket_csv(mask) -> str:
        """Slice sf_df by a boolean mask and return CSV bytes for download."""
        cols = [
            "case_number", "type", "status", "is_escalated", "is_closed",
            "gm_key", "gm_status", "gm_reached_qa", "gm_has_bug",
            "gm_is_concluded", "gm_is_in_progress", "gm_teo_reviewed",
            "severity", "gm_team", "product", "account", "resolve_hours",
        ]
        available = [c for c in cols if c in sf_df.columns]
        return sf_df.loc[mask, available].to_csv(index=False)


    _period_tag = f"{range_start:%Y%m%d}_{range_end:%Y%m%d}"

    # EA-quantified companions for the SF-quantified KPIs below — same
    # already-computed counts as the Bucket Counts table above, just
    # expressed as a rate over `total_ea` (EAs created in the period)
    # instead of a rate over `total_sf`. Ticket → GM has no EA companion
    # of its own — on the EA side there's no "any creation date" variant
    # the way SF cases can point at an old GM (an EA either was created
    # this period or it wasn't), so its EA-side population is identical to
    # Ticket → TEO's; shown once, under TEO, rather than duplicated.
    ea_ticket_to_teo = (ea_in_period_linked_to_sf / total_ea) if total_ea else 0
    ea_ticket_to_qa = (ea_concluded_from_qa / total_ea) if total_ea else 0

    # ── Row 1: Ticket Flow (SF ↔ GM linkage, funnel order) ──────────────────
    _section_header("🎯 Ticket Flow")
    c1, c_teo, c2 = st.columns(3)

    with c1:
        if sf_available and total_sf:
            _kpi_card("🔗", "Ticket → GM", f"{kpi1:.1%}",
                      f"{sf_any_gm_link:,}/{total_sf:,} SF cases", "#2E7DD6")
            if sf_any_gm_link:
                st.download_button(
                    f"⬇ {sf_any_gm_link} any-GM-link cases (CSV)",
                    _bucket_csv(sf_df["gm_key_raw"] != ""),
                    f"ticket_to_gm_{_period_tag}.csv",
                    "text/csv", key="dl_kpi1",
                )
        elif sf_available:
            _kpi_card("🔗", "Ticket → GM", "—", "No SF cases in period", "#9AA0A6")
        else:
            _kpi_card("🔗", "Ticket → GM", "N/A", "Run `sf org login web`", "#9AA0A6")

    with c_teo:
        if sf_available and total_sf:
            _kpi_card(
                "🏷️", "Ticket → TEO", f"{kpi_ticket_to_teo:.1%}",
                f"{sf_linked_to_gm:,}/{total_sf:,} SF cases", "#1AA179",
                note=(
                    f"EA → Ticket (TEO): <b>{ea_ticket_to_teo:.1%}</b> "
                    f"({ea_in_period_linked_to_sf:,}/{total_ea:,} Month EAs)"
                ),
            )
            if sf_linked_to_gm:
                st.download_button(
                    f"⬇ {sf_linked_to_gm} TEO-linked cases (CSV)",
                    _bucket_csv(sf_df["gm_key"] != ""),
                    f"ticket_to_teo_{_period_tag}.csv",
                    "text/csv", key="dl_kpi_teo",
                )
        else:
            _kpi_card("🏷️", "Ticket → TEO", "N/A", "SF unavailable", "#9AA0A6")

    with c2:
        if sf_available and total_sf:
            _kpi_card(
                "🧪", "Ticket → QA", f"{kpi2:.1%}",
                f"{sf_ticket_to_qa:,}/{total_sf:,} SF cases", "#8E5CD9",
                note=(
                    f"EA → Ticket (QA): <b>{ea_ticket_to_qa:.1%}</b> "
                    f"({ea_concluded_from_qa:,}/{total_ea:,} Month EAs)"
                ),
            )
            if sf_ticket_to_qa:
                qa_mask = (
                    (sf_df["gm_key"] != "")
                    & ~sf_df["gm_key_raw"].isin(teo_filter_keys)
                )
                st.download_button(
                    f"⬇ {sf_ticket_to_qa} Ticket→QA cases (CSV)",
                    _bucket_csv(qa_mask),
                    f"ticket_to_qa_{_period_tag}.csv",
                    "text/csv", key="dl_kpi2",
                )
        else:
            _kpi_card("🧪", "Ticket → QA", "N/A", "SF unavailable", "#9AA0A6")

    st.markdown("<div style='height:14px;'></div>", unsafe_allow_html=True)

    # ── Row 2: Bug Quality (EA-quantified) ──────────────────────────────────
    _section_header("🐞 Bug Quality")
    c3, c4 = st.columns(2)

    with c3:
        _direct_ct = len(_direct_bug_keys)
        _via_dup_ct = ea_to_bug_num - _direct_ct
        _kpi_card(
            "🐞", "EA → Bug", f"{kpi3:.1%}",
            f"{ea_to_bug_num:,}/{ea_to_bug_den:,} Month EAs concluded", "#E0793C",
            note=(
                f"{_direct_ct:,} resolved directly + {_via_dup_ct:,} via "
                f"Duplicate chase" if _via_dup_ct else f"All {_direct_ct:,} resolved directly"
            ),
        )
        if ea_to_bug_num and not df.empty:
            ea_bug_csv = df.loc[
                df["key"].isin(ea_to_bug_keys)
            ].to_csv(index=False)
            st.download_button(
                f"⬇ {ea_to_bug_num} EAs concluded as Known/New Bug (CSV)",
                ea_bug_csv,
                f"ea_to_bug_{_period_tag}.csv",
                "text/csv", key="dl_kpi3",
            )

    with c4:
        _kpi_card(
            "⚠️", "Bug Rejection %", f"{bug_rejection_rate:.1%}",
            f"{bug_rejection_num:,}/{bug_rejection_den:,} EAs (direct Known/New Bug)",
            "#D64545",
        )
        if bug_rejected_keys and not df.empty:
            rejection_csv = df.loc[df["key"].isin(bug_rejected_keys)].assign(
                linked_bug=lambda d: d["key"].map(
                    lambda k: ", ".join(_linked_bug_keys_by_ea.get(k, []))
                ),
            ).to_csv(index=False)
            st.download_button(
                f"⬇ {bug_rejection_num} EAs w/ Rejected linked Bug (CSV)",
                rejection_csv,
                f"bug_rejection_{_period_tag}.csv",
                "text/csv", key="dl_kpi4",
            )

    st.markdown("<div style='height:14px;'></div>", unsafe_allow_html=True)

    # ── Row 3: Process Gaps & Improvements (EA-quantified) ────────────────────
    _section_header("🛠️ Process Gaps & Improvements")
    c5, c6 = st.columns(2)

    with c5:
        _kpi_card(
            "🛠️", "EA → PG", f"{kpi_pg:.1%}",
            f"{ea_to_pg_num:,}/{ea_to_pg_den:,} Month EAs concluded", "#4C8BF5",
        )
        if ea_to_pg_num and not df.empty:
            ea_pg_csv = df.loc[df["key"].isin(ea_to_pg_keys)].to_csv(index=False)
            st.download_button(
                f"⬇ {ea_to_pg_num} EAs concluded as Process Gap (CSV)",
                ea_pg_csv,
                f"ea_to_pg_{_period_tag}.csv",
                "text/csv", key="dl_kpi_pg",
            )

    with c6:
        _kpi_card(
            "📈", "EA → Improvements", f"{kpi_improvement:.1%}",
            f"{ea_to_improvement_num:,}/{ea_to_improvement_den:,} Month EAs concluded",
            "#2FA36B",
            note="Bug + Process Gap combined",
        )
        if ea_to_improvement_num and not df.empty:
            ea_impr_csv = df.loc[df["key"].isin(ea_to_improvement_keys)].to_csv(index=False)
            st.download_button(
                f"⬇ {ea_to_improvement_num} EAs = Bug ∪ PG (CSV)",
                ea_impr_csv,
                f"ea_to_improvements_{_period_tag}.csv",
                "text/csv", key="dl_kpi_impr",
            )

    st.markdown("<div style='height:6px;'></div>", unsafe_allow_html=True)

    # Expandable "what do these mean?" panel — same content as the per-metric `?`.
    with st.expander("How are these KPIs calculated? (full rules)"):
        for name, rule in KPI_RULES.items():
            st.markdown(f"### {name}")
            st.markdown(rule)

    # ── Charts (no SF-only strip anymore — bucket row above carries volume info) ──
    if sf_available and total_sf:
        st.divider()

        # ── EA KPIs by GM Origin (Jira customfield_10620) ─────────────────────────
        # Per-EA breakdown of period-scope tickets by their GM Origins value(s).
        # An EA can carry multiple origins (multi-select picklist) — we explode so
        # each (EA, origin) becomes its own row. Stacked segments:
        #   • "Concluded → Bug"     (resolution ∈ BUG_RESOLUTIONS)
        #   • "Concluded → No Bug"  (concluded, not a bug outcome)
        #   • "In Progress"         (status ≠ Done)
        if not df.empty and df["gm_origins"].apply(bool).any():
            def _ea_bucket(row):
                if row["is_concluded"] and row["has_bug"]:
                    return "Concluded → Bug"
                if row["is_concluded"]:
                    return "Concluded → No Bug"
                return "In Progress"

            ea_annot = df.assign(sub_bucket=df.apply(_ea_bucket, axis=1))
            ea_exploded = ea_annot.explode("gm_origins").rename(
                columns={"gm_origins": "gm_origin"}
            )
            ea_exploded = ea_exploded[ea_exploded["gm_origin"].notna() &
                                      (ea_exploded["gm_origin"] != "")]
            if not ea_exploded.empty:
                origin_split = (
                    ea_exploded.groupby(["gm_origin", "sub_bucket"]).size()
                    .reset_index(name="EAs")
                )
                origin_totals = (
                    ea_exploded.groupby("gm_origin").size()
                    .sort_values(ascending=False).head(15)
                )
                keep = list(origin_totals.index)
                origin_split = origin_split[origin_split["gm_origin"].isin(keep)]
                origin_split["gm_origin"] = pd.Categorical(
                    origin_split["gm_origin"], categories=keep, ordered=True,
                )
                fig_origin = px.bar(
                    origin_split, x="gm_origin", y="EAs", color="sub_bucket",
                    color_discrete_map={
                        "Concluded → Bug": "#F44336",
                        "Concluded → No Bug": "#4CAF50",
                        "In Progress": "#FF9800",
                    },
                    category_orders={"sub_bucket": [
                        "Concluded → Bug", "Concluded → No Bug", "In Progress",
                    ]},
                    title=(f"EA KPIs by GM Origin — period-scope EAs split by "
                           f"outcome (top {len(keep)} origins shown; multi-origin "
                           f"EAs counted once per origin)"),
                    labels={"gm_origin": "GM Origin (Jira `customfield_10620`)",
                            "EAs": "EA tickets",
                            "sub_bucket": "EA outcome"},
                    text="EAs",
                )
                fig_origin.update_layout(height=460, barmode="stack",
                                         xaxis_tickangle=-30)
                st.plotly_chart(fig_origin, use_container_width=True)

        # ── EA tickets closed AFTER reaching QA — by status ───────────────────────
        closed_after_qa = df[df["reached_qa"] & (df["resolution"] != "")] \
            if not df.empty else pd.DataFrame()
        if not closed_after_qa.empty:
            st.divider()
            st.subheader("EA tickets closed AFTER reaching QA — bucketed by status")
            st.caption(
                "EAs (created in period) that reached a QA status AND now have a "
                "resolution set. Status chart on left, resolution breakdown on right "
                "(most closures land on Status=Done, so the resolution is the real "
                "signal)."
            )
            sc1, sc2 = st.columns(2)
            with sc1:
                status_counts = (
                    closed_after_qa.groupby("status").size().reset_index(name="count")
                    .sort_values("count", ascending=False)
                )
                fig_after_qa_status = px.bar(
                    status_counts, x="status", y="count", color="status",
                    title=(f"Closed after QA — by Status "
                           f"(total = {len(closed_after_qa)})"),
                    labels={"status": "Jira Status", "count": "EA tickets"},
                    text="count",
                )
                fig_after_qa_status.update_layout(
                    showlegend=False, height=360,
                    xaxis={"categoryorder": "total descending"},
                )
                st.plotly_chart(fig_after_qa_status, use_container_width=True)
            with sc2:
                res_counts = (
                    closed_after_qa.groupby("resolution").size().reset_index(name="count")
                    .sort_values("count", ascending=False)
                )
                fig_after_qa_res = px.bar(
                    res_counts, x="count", y="resolution", orientation="h",
                    color="resolution",
                    title=f"Closed after QA — by Resolution",
                    labels={"resolution": "Resolution", "count": "EA tickets"},
                    text="count",
                )
                fig_after_qa_res.update_layout(
                    showlegend=False, height=360,
                    yaxis={"categoryorder": "total ascending"},
                )
                st.plotly_chart(fig_after_qa_res, use_container_width=True)

    # ── Funnel charts ──────────────────────────────────────────────────────────────
    st.divider()

    # Derived counts for the EA funnel (EAs as the unit, period EAs only)
    linked_in_period_keys = set(gm_status.keys()) & all_linked_keys_from_sf
    ea_linked_reached_qa = sum(
        1 for k in linked_in_period_keys if gm_status.get(k, {}).get("reached_qa")
    )
    ea_linked_strict_bug = sum(
        1 for k in linked_in_period_keys
        if gm_status.get(k, {}).get("has_strict_bug")
    )

    funnel_cols = st.columns(2 if (sf_available and total_sf) else 1)

    # ── SF Case Flow funnel: 5-stage SF-side funnel ─────────────────────────────
    if sf_available and total_sf:
        with funnel_cols[0]:
            sf_funnel = go.Figure(
                go.Funnel(
                    y=[
                        "Total SF Cases",
                        "EA-linked SF (any EA date)",
                        "New-EA SF (EA in period)",
                        "→ EA reached QA",
                        f"→ Strict Bug ({'/'.join(sorted(STRICT_BUG_RESOLUTIONS))})",
                    ],
                    x=[
                        total_sf, sf_any_gm_link, sf_linked_to_gm,
                        sf_reached_qa, sf_with_strict_bug,
                    ],
                    textinfo="value+percent initial",
                    marker_color=["#0D47A1", "#1565C0", "#1976D2",
                                  "#FF9800", "#F44336"],
                )
            )
            sf_funnel.update_layout(
                title=f"SF Case Flow — {period_label}",
                height=380,
                margin=dict(l=20, r=20, t=40, b=20),
            )
            st.plotly_chart(sf_funnel, use_container_width=True)

    # ── EA Ticket Flow funnel: distinct EAs as the unit ─────────────────────────
    ea_funnel_col = funnel_cols[-1]
    with ea_funnel_col:
        fig_funnel = go.Figure(
            go.Funnel(
                y=[
                    "EAs linked with SF (any creation date)",
                    "New EAs (created in period)",
                    "→ Reached QA",
                    f"→ Strict Bug ({'/'.join(sorted(STRICT_BUG_RESOLUTIONS))})",
                ],
                x=[
                    len(all_linked_keys_from_sf),
                    ea_in_period_linked_to_sf,
                    ea_linked_reached_qa,
                    ea_linked_strict_bug,
                ],
                textinfo="value+percent initial",
                marker_color=["#1565C0", "#1976D2", "#FF9800", "#F44336"],
            )
        )
        fig_funnel.update_layout(
            title=f"EA Ticket Flow — {period_label}",
            height=380,
            margin=dict(l=20, r=20, t=40, b=20),
        )
        st.plotly_chart(fig_funnel, use_container_width=True)

    # ── TEO Leakage ────────────────────────────────────────────────────────────────
    # Leakage scope = **Month EAs — Concluded** (bucket card 7, the EA → Bug
    # denominator). Of those concluded month EAs:
    #   - QA-transited = changelog reached `QA analysis in progress`
    #   - Bug = resolution ∈ {Known Bug, New Bug}
    #   - Leakage = QA-transited - Bug
    leakage_universe = month_eas_concluded_keys
    leakage_qa_count = sum(
        1 for k in leakage_universe
        if gm_status.get(k, {}).get("reached_qa_ip")
    )
    # Bug-resolved EAs SHOULD have also reached QA in practice. Intersect to
    # guarantee numerator ≤ denominator regardless of data noise.
    leakage_bug_in_qa = sum(
        1 for k in leakage_universe
        if gm_status.get(k, {}).get("reached_qa_ip")
        and gm_status.get(k, {}).get("has_kpi_bug")
    )
    teo_leakage_count = leakage_qa_count - leakage_bug_in_qa
    teo_leakage_rate = (teo_leakage_count / leakage_qa_count) if leakage_qa_count else 0

    st.divider()
    st.subheader(f"TEO Leakage — {period_label}")
    st.caption(
        f"Scope: **Month EAs — Concluded** (QA-resolved only). EAs created "
        f"in the selected month, linked from at least one in-period SF case, "
        f"concluded (status ∈ {{Done, No longer an issue, Unable to Conclude}}), "
        f"and NOT in the TEO-resolved filter set. Universe size: "
        f"**{len(leakage_universe):,} EAs** — same as the EA → Bug denominator."
    )
    l1, l2, l3 = st.columns(3)
    l1.metric(
        "EAs transited to QA", f"{leakage_qa_count:,}",
        help=(
            "Concluded in-period EAs (status ∈ {Done, No longer an issue, "
            "Unable to Conclude}, also linked from at least one in-period "
            "SF case) whose changelog shows a transition to status "
            "`QA analysis in progress`. Same QA-check as Ticket → QA (KPI 2). "
            "Subset of `EAs created in period` (= Bucket card 4) further "
            "narrowed to concluded EAs.\n\n"
            "Since each EA can be linked from multiple SF cases, this count "
            "is ALWAYS ≤ Ticket → QA SF count."
        ),
    )
    l2.metric(
        "EAs concluded as Known/New Bug",
        f"{leakage_bug_in_qa:,}",
        help=(
            "Subset of the above whose resolution ∈ {Known Bug, New Bug} "
            "(same set as EA → Bug KPI). Subtracted from QA-transited to "
            "get the leakage count."
        ),
    )
    l3.metric(
        "TEO Leakage",
        f"{teo_leakage_count:,}",
        f"{teo_leakage_rate:.1%} of QA-transited",
        help=(
            "**Leakage = EAs that reached `QA analysis in progress` − EAs "
            "concluded as Known/New Bug**, scoped to in-period EAs linked "
            "from SF cases.\n\n"
            "These are tickets where TEO sent the issue to QA, but the QA "
            "cycle did not produce a confirmed bug. The resolution chart "
            "below shows where those leaked tickets ended up (typically "
            "TEO-closure categories: Invalid Use Case, Logs Unavailable, "
            "Manual Intervention, Wrong Configuration, etc.)."
        ),
    )

    # Resolution breakdown for the leaked tickets (in-period & SF-linked, in scope)
    if leakage_universe and not df.empty:
        leak_keys = {
            k for k in leakage_universe
            if gm_status.get(k, {}).get("reached_qa_ip")
            and not gm_status.get(k, {}).get("has_kpi_bug")
        }
        leak_df = df[df["key"].isin(leak_keys)]
        if not leak_df.empty:
            leak_res = (
                leak_df.assign(
                    resolution=leak_df["resolution"].replace("", "(none)")
                )
                .groupby("resolution").size().reset_index(name="count")
                .sort_values("count", ascending=False)
            )
            fig_leak = px.bar(
                leak_res, x="resolution", y="count", color="resolution",
                title=(f"TEO Leakage — resolution mix of "
                       f"{int(leak_df.shape[0])} leaked EAs"),
                labels={"resolution": "Resolution", "count": "EA tickets"},
                text="count",
            )
            fig_leak.update_layout(
                showlegend=False, height=380,
                xaxis={"categoryorder": "total descending"},
            )
            st.plotly_chart(fig_leak, use_container_width=True)

            with st.expander(f"Show all {len(leak_df)} leaked EAs"):
                st.dataframe(
                    leak_df[[
                        "key", "summary", "status", "resolution", "teo_reviewed",
                    ]].rename(columns={
                        "key": "EA", "summary": "Summary",
                        "status": "Status", "resolution": "Resolution",
                        "teo_reviewed": "TEO Reviewed",
                    }),
                    use_container_width=True, height=400,
                )
                st.download_button(
                    f"⬇ {len(leak_df)} leaked EAs (CSV)",
                    leak_df.to_csv(index=False),
                    f"teo_leakage_{_period_tag}.csv",
                    "text/csv", key="dl_leakage",
                )
        else:
            st.info("No leaked EAs — every QA-transited linked EA also "
                    "concluded as a bug.")

    # ── Resolution breakdown ───────────────────────────────────────────────────────
    if not df.empty and df["resolution"].any():
        st.divider()
        st.subheader("Resolution Breakdown")
        res_counts = (
            df[df["resolution"] != ""]
            .groupby("resolution")
            .size()
            .reset_index(name="count")
            .sort_values("count", ascending=False)
        )
        if not res_counts.empty:
            fig_res = px.bar(
                res_counts,
                x="resolution",
                y="count",
                color="resolution",
                title="Closed tickets by resolution",
                labels={"resolution": "Resolution", "count": "Count"},
            )
            fig_res.update_layout(showlegend=False, height=320)
            st.plotly_chart(fig_res, use_container_width=True)

    # ── QA vs non-QA breakdown ─────────────────────────────────────────────────────
    st.divider()
    st.subheader("Ticket Status Overview")
    overview_data = {
        "Category": [
            "Closed — Bug",
            "Closed — TEO Closure",
            "Reached QA (no bug yet)",
            "Still in TAC/Analysis",
        ],
        "Count": [
            ea_with_bug,
            int(df["resolution"].isin(TEO_CLOSURE_RESOLUTIONS).sum()) if not df.empty else 0,
            ea_reached_qa - ea_with_bug,
            total_ea - ea_reached_qa - (int(df["resolution"].isin(TEO_CLOSURE_RESOLUTIONS).sum()) if not df.empty else 0) - ea_with_bug,
        ],
    }
    # Clamp negatives (tickets can overlap categories)
    overview_data["Count"] = [max(0, v) for v in overview_data["Count"]]
    fig_pie = px.pie(
        overview_data,
        names="Category",
        values="Count",
        title=f"Ticket outcomes — {period_label}",
        color_discrete_sequence=["#F44336", "#4CAF50", "#FF9800", "#9E9E9E"],
    )
    fig_pie.update_layout(height=360)
    st.plotly_chart(fig_pie, use_container_width=True)

    # ── Drill-down table ───────────────────────────────────────────────────────────
    st.divider()
    st.subheader("All Engineering Analysis Tickets")

    filter_col1, filter_col2 = st.columns(2)
    with filter_col1:
        show_qa_only = st.checkbox("Show QA-reached only")
    with filter_col2:
        show_bug_only = st.checkbox("Show bug-linked only")

    display_df = df.copy()
    if show_qa_only:
        display_df = display_df[display_df["reached_qa"]]
    if show_bug_only:
        display_df = display_df[display_df["has_bug"]]

    if not display_df.empty:
        display_df["jira_link"] = display_df["key"].apply(
            lambda k: f"{JIRA_URL}/browse/{k}"
        )
        st.dataframe(
            display_df[
                ["key", "summary", "status", "resolution", "teo_reviewed", "reached_qa", "has_bug", "bug_keys"]
            ].rename(
                columns={
                    "key": "Ticket",
                    "summary": "Summary",
                    "status": "Status",
                    "resolution": "Resolution",
                    "teo_reviewed": "TEO Reviewed",
                    "reached_qa": "Reached QA",
                    "has_bug": "Has Bug",
                    "bug_keys": "Linked Bugs",
                }
            ),
            use_container_width=True,
            height=400,
        )

        csv = display_df.to_csv(index=False)
        st.download_button(
            "Download CSV",
            csv,
            f"teo_kpi_jira_{range_start:%Y%m%d}_{range_end:%Y%m%d}.csv",
            "text/csv",
        )
    else:
        st.info("No tickets match the current filters.")

    # ── SF cases drill-down ────────────────────────────────────────────────────────
    if sf_available and not sf_df.empty:
        st.divider()
        st.subheader("Salesforce Cases")
        sf_filter_cols = st.columns(3)
        with sf_filter_cols[0]:
            show_escalated_only = st.checkbox("Escalated only")
        with sf_filter_cols[1]:
            show_gm_linked_only = st.checkbox("GM-linked only")
        with sf_filter_cols[2]:
            show_closed_only = st.checkbox("Closed only")

        sf_display = sf_df.copy()
        if show_escalated_only:
            sf_display = sf_display[sf_display["is_escalated"]]
        if show_gm_linked_only:
            sf_display = sf_display[sf_display["gm_key"] != ""]
        if show_closed_only:
            sf_display = sf_display[sf_display["is_closed"]]

        if not sf_display.empty:
            # Add deep links: case URL + GM ticket URL
            instance_url = (_sf_cli or {}).get("instance_url") or _sf_instance_url
            sf_display = sf_display.assign(
                case_url=sf_display["case_number"].apply(
                    lambda cn: f"{instance_url}/lightning/r/Case/{cn}/view"
                    if cn else ""
                ),
                gm_url=sf_display["gm_key"].apply(
                    lambda k: f"{JIRA_URL}/browse/{k}" if k else ""
                ),
            )
            st.dataframe(
                sf_display[[
                    "case_number", "type", "status", "is_escalated", "is_closed",
                    "gm_key", "gm_reached_qa", "gm_has_bug",
                    "severity", "gm_team", "product", "resolve_hours",
                ]].rename(columns={
                    "case_number": "Case #", "type": "Type",
                    "status": "Status",
                    "is_escalated": "Escalated", "is_closed": "Closed",
                    "gm_key": "GM Ticket",
                    "gm_reached_qa": "GM Reached QA",
                    "gm_has_bug": "GM Has Bug",
                    "severity": "Severity",
                    "gm_team": "GM Team", "product": "Product",
                    "resolve_hours": "Resolve (h)",
                }),
                use_container_width=True,
                height=400,
            )

            sf_csv = sf_display.to_csv(index=False)
            st.download_button(
                "Download SF cases CSV",
                sf_csv,
                f"teo_kpi_sf_{range_start:%Y%m%d}_{range_end:%Y%m%d}.csv",
                "text/csv",
                key="sf_csv",
            )
        else:
            st.info("No cases match the current filters.")

    # ── Summary stats ──────────────────────────────────────────────────────────────
    st.divider()
    sf_summary = ""
    if sf_available:
        sf_summary = (
            f" | SF cases: {total_sf} (escalated: {sf_escalated}, "
            f"GM-linked: {sf_linked_to_gm}, closed: {sf_closed})"
        )
    st.caption(
        f"Data as of {datetime.now().strftime('%Y-%m-%d %H:%M')}. "
        f"EA tickets: {total_ea} | TEO Reviewed: {teo_reviewed_count} | "
        f"Reached QA: {ea_reached_qa} | Converted to Bug: {ea_with_bug}"
        f"{sf_summary}"
    )


render_dashboard()
