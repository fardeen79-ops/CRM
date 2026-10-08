# Go-live upload files

Built from the staff list supplied on 8 October 2026 (`New_HRMS_Code.xlsx`, sheet "Sales Staff", 360 rows). Both files load through **Bulk upload** as the business head or DXB MIS, in this order:

1. **Staff** → `staff-upload.csv` (406 rows: 10 sales managers, 36 team leaders, 360 sales staff). The upload creates leaders first, then staff, and shows a temporary password for every new login. Sales staff sign in with their HRMS code; leaders sign in with the email in the file until an HRMS code is added to their profile.
2. **Salary targets** → `salary-targets.csv` (66 bands). Then press **Generate from salaries** on the Targets page for the cycle.

Loading both into a scratch copy of the CRM gave: 406 users created, 0 failed; 66 bands saved; targets generated for all 360 sales staff, every one equal to the sheet's Point Target.

## How the sheet was mapped

| Sheet column | CRM field | Notes |
|---|---|---|
| SALES CODE | Sales code | As given |
| NEW HRMS CODE | HRMS code | The username at sign-in |
| SE NAME | Full name | Title-cased |
| DOJ | Date of joining | |
| STATUS | Date of leaving | The one Inactive row (F4Q2) gets a leaving date so the account is disabled; set the real date on her profile |
| PRODUCT | Core product | CC → Credit Cards, PL → Personal Loans, AL → Auto Loans |
| TEAM LEADER | Team leader | Where the team leader is also a sales manager (Priyanka, Tanveer Shirgar, Jayakrishnan, Jigar Bhavsar, Shaharyab Khan, Praphuldas, Abdul Kader, Praveen PV) one account is created, as a sales manager who also leads a team directly |
| SM / ASM | Sales manager | All treated as sales managers (the sheet does not say which are ASMs). "-" (Raji John's auto loan team, 12 staff) is left blank: the team reports to the business head directly |
| MANAGER | not loaded | Fardeen (DXB) and Noman Najam (AUH) are the two business heads. Create them from the Staff page with the Business head role and their region |
| LOCATION | Region | DXB or AUH, on every account |
| Salary | Monthly salary | Drives the targets |
| Point Target | Salary bands | Reproduced exactly by the bands in `salary-targets.csv`, see below |

## Placeholders to replace

- **Emails** are placeholders: `hrms<code>@derbygroup.local` for staff, `first.last@derbygroup.local` for leaders. Replace them on the Staff page when the real addresses are known. Staff sign in with the HRMS code, so the placeholder does not block anyone.
- **Mobile and WhatsApp numbers** are blank. WhatsApp alerts are on hold, so nothing needs them yet.
- **Leaders' HRMS codes** are blank. Add them on the Staff page so leaders can sign in by code.

## Salary bands

The sheet's Point Target follows the salary in AED 500 steps from 4,000:

| Product | Target at AED 4,000 to 4,499 | Each further AED 500 of salary |
|---|---|---|
| Credit Card | 5,850 points | +800 points |
| Personal Loan | AED 500,000 | +AED 50,000 |
| Auto Loan | 2,400 points | +800 points |

`salary-targets.csv` carries these bands from AED 4,000 up to AED 14,999. Every salary in the sheet falls between 4,000 and 10,000; bands above that are the same rule carried forward, and a salary outside every band is reported when targets are generated. Each staff member gets the target of their core product only. Accounts have no band in the sheet, so no accounts target is generated.

## Still needed

- The **auto loan points table** (points per loan by amount band), so auto loan achievement counts in points against the targets above. Until then each auto loan counts 1 point.
- The ASM distinction, if any of the SM / ASM names are ASMs rather than sales managers.
