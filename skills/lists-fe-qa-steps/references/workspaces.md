# Lists Monorepo — Workspace Reference

All workspaces live under the `lists` repo root. Each is an independently deployed federated module.

## Workspace Map

| Workspace Dir | Package | Port | Start From | Requestly Rule(s) | Primary Routes |
|---|---|---|---|---|---|
| `lists-web` | @joltup/lists-web | 3874 | repo root | `live lists to local lists web` | `/content/lists/...` (list templates), `/review/review/...` (reports & dashboards), `/reviewDay/...` (calendar), `/consumerDashboard` |
| `asset-management` | @joltup/asset-management | 3873 | workspace | `Live Asset Management to Local Management` | /asset/manage/grid, /asset/manage/templates |
| `audit-lists` | @joltup/audit-lists | 3999 | workspace | check file | /auditLists/manage/grid |
| `company-web` | @joltup/company-web | 3876 | workspace | `live company to local company web` | /company/structure/ |
| `company-dashboard` | @joltup/company-dashboard | 3875 | workspace | `live dashboard to local company dashboard` | /company/dashboard |
| `leave-behind-report` | @joltup/leave-behind-report | 3884 | workspace | `Leave Behind Report` | /content/leaveBehindReport/manage |
| `location-tag-management` | @joltup/location-tag-management | 3886 | workspace | `Location Tag Management`, `Lists Repo` | /content/locationTag/manage |
| `people` | @joltup/people | 3878 | workspace | `live people to local people` | /peoplev2 |
| `product-management` | @joltup/product-management | 3887 | workspace | check file | /content/product/manage |
| `schedule` | @joltup/schedule | 3874 | workspace | `live schedule to local schedule` | /schedule/availability |
| `tag-management` | @joltup/tag-management | 3883 | workspace | check file | /content/tag/manage |
| `time-temperature` | @joltup/time-temperature | 3374 | workspace | check file | /time-temperature |
| `work-orders` | @joltup/work-orders | 3877 | workspace | `Work Orders`, `Lists Repo` | /workOrders/manage/grid, /workOrders/manage/templates |

**"check file"** means no requestly rule is tracked in the repo for that workspace. Read the workspace's `requestly_rules.json` or `requestly_rules.txt` to get the rule name. If no file exists, instruct the tester to set up a manual redirect from the CDN URL to `http://localhost:<port>/bundle.js`.

**"Start From"** notes:
- `repo root` — run `npm start` from the `lists` repo root (the command also runs the relay compiler)
- `workspace` — `cd` into the workspace directory first, then run `npm start`

### Port collisions

- `lists-web` and `schedule` both listen on **3874**. They cannot run simultaneously. If a ticket touches both, QA each in a separate session (stop one, start the other).
- Storybook for `lists-web-components` and `lists-web-data-components` both default to **6006**. Same rule — start one at a time, or override the port with `npm start -- -p <other-port>`.

## Shared Libraries (no direct QA entry point)

These packages have no standalone URL — they are consumed by app workspaces.

| Workspace Dir | Package | Notes |
|---|---|---|
| `lists-web-components` | @joltup/lists-web-components | UI primitives; Storybook on port 6006 (`npm start` in workspace) |
| `lists-web-data-components` | @joltup/lists-web-data-components | Data-connected UI; Storybook on port 6006 |
| `lists-core` | @joltup/lists-core | Business logic; no UI |
| `lists-hooks` | @joltup/lists-hooks | React hooks; no UI |
| `template-and-instance-management` | @joltup/template-and-instance-management | Shared template builder; consumed by `lists-web`, `work-orders`, `asset-management`, and `audit-lists` |
| `shared-dev-utils` | @joltup/shared-dev-utils | Dev utilities; no UI |

## Non-QA Workspaces

These workspaces exist in the monorepo but **do not produce QA steps**. If a diff is *only* in one of these, report "no QA needed" and stop.

| Workspace Dir | Package | Reason |
|---|---|---|
| `lists-files` | @joltup/list-files | Static asset bundle (fonts, images) — no `src/`, no `start` script. Note the package is `list-files` (singular), not `lists-files`. |
| `integration-tests` | @joltup/integration-tests | Cypress E2E test suite. Changes here are tests *of* the app, not changes *to* the app. |

## Navigation Reference

Common navigation patterns used in QA steps:

| Feature Area | Navigation Path |
|---|---|
| Audit lists grid | Audits & Inspections → Manage |
| Audit & Inspection templates | Audits & Inspections → Leave Behind Templates |
| Leave behind report settings | Audits & Inspections → Leave Behind Templates → select template → ⋮ → Settings |
| List templates | Lists → Templates |
| Work order templates | Work Orders → Templates |
| Work order grid | Work Orders → Manage |
| Asset templates | Assets → Templates |
| Asset grid | Assets → Manage |
| People / users | People |
| Schedule | Schedule → Availability |
| Company structure | Company → Structure |
| Tag management | Content → Tags |
| Location tags | Content → Location Tags |
| Products | Content → Products |
| Time & temperature | Time & Temperature |

## Example QA Steps (reference: LW-16395)

```
QA Steps:

* Repo: lists/leave-behind-report
  * Command: `npm start`
  * Requestly rule: Leave Behind Report

* Go to Audits & Inspections in the nav
* Go to Leave Behind Templates
* Select a template from the top left dropdown
* Select the 3 dot menu in the top right
* Go to Settings
* In the Company Logo section, see the green icon next to the description
* Hover over it and verify the tooltip appears
```
