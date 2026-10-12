# Go-live upload files

Built from the staff list supplied on 8 October 2026 (`New_HRMS_Code.xlsx`, sheet "Sales Staff", 360 rows). Both files load through **Bulk upload** as the business head or DXB MIS, in this order:

1. **Staff** → `staff-upload.csv` (433 rows: 2 business heads, 10 sales managers, 36 team leaders, 360 sales staff, 17 processing, 4 governance, 4 staff with no access). **One row (Noman Najam) still has no HRMS code** (see *Salary details* below): the code is mandatory for every role and the upload rejects a row without one (and then the sales rows that name that leader). The upload creates leaders first, then staff, and shows a temporary password for every new login. Everyone signs in with their HRMS code.
2. **Salary targets** → `salary-targets.csv` (66 bands, with the credit card bonus level in the last column). Then press **Generate from salaries** on the Targets page for the cycle.

Loading both into a scratch copy of the CRM (with a placeholder code for Noman) gave: 433 users created, 0 failed; 66 bands saved; targets generated for all 360 sales staff, every one equal to the sheet's target.

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
| Point Target | Salary bands | Points for credit cards and auto loans (an auto loan's points are its disbursed amount at the bank's payout rate: 0.80% new and used, 0.25% algo), **AED to disburse for personal loans**. Reproduced exactly by the bands in `salary-targets.csv`, see below |

## Salary details (12 October 2026)

`Salary_Details.xlsx` (68 rows: business heads, SM, ASM, TL, processors, settlement officers, compliance, one biker) filled the leader rows' **HRMS codes and monthly salaries** and added the non-sales staff, so every salary is in the profit and loss:

| Sheet department | CRM role | Notes |
|---|---|---|
| BUSINESS HEAD | Business head | Fardeen (DXB, 1012) and Noman Najam (AUH). **Noman's HRMS code is still to come**; his row is rejected until it is filled |
| SM, ASM, TL | as already in the file | Matched by name to the 41 leaders the file had; HRMS code and salary filled. Roles were **not** changed (see below) |
| PROCESSOR | Processing | 17 rows |
| SETTLEMENT OFFICER, BIKER | Staff (no access) | 4 rows: on the books for the profit and loss (salary, region, headcount) but the account cannot sign in |
| COMPLIANCE | Governance | 4 rows |

The five leaders missing from the first sheet (Jigar Bhavsar, Varun Gupta, Mrudula Thirunilathil, Jibin Rajan, Laijomon Joseph) came in a second sheet (`Salary_Details - missing.xlsx`) and are filled in. **Only Noman Najam's HRMS code is still blank**; his row is the one the upload rejects.

**Designations differ from the sales sheet.** The salary sheets call these nine **ASM**: Tanveer Shirgar, Shaharyab Khan and Varun Gupta (sales managers in the file), Abdul Kader (sales manager, AUH), Sangaralingam, Ignatius Pramod Fernandes, Sajjad Hussain, Suneel Kumar Jain and Zeeshan Patel (team leaders in the file). The file keeps the roles the sales sheet implied, because the role decides which incentive scheme applies (a team leader's scheme or a manager's); change them on the Staff page once the business confirms who is paid as an ASM. Priyanka is a team leader on the salary sheet (AED 10,000) but manages teams in the sales sheet, so she stays a sales manager.

## Placeholders to replace

- **Emails** are placeholders: `hrms<code>@derbygroup.local` for staff, `first.last@derbygroup.local` for leaders. Replace them on the Staff page when the real addresses are known. Staff sign in with the HRMS code, so the placeholder does not block anyone.
- **Mobile and WhatsApp numbers** are blank. WhatsApp alerts are on hold, so nothing needs them yet.
- **HRMS codes** are now filled from the salary sheets; only Noman Najam's is blank (above).

## Salary bands

The sheet's target column (points for CC and AL, AED for PL) follows the salary in AED 500 steps from 4,000:

| Product | Target at AED 4,000 to 4,499 | Each further AED 500 of salary |
|---|---|---|
| Credit Card | 5,850 points | +800 points |
| Personal Loan | AED 500,000 | +AED 50,000 |
| Auto Loan | 2,400 points | +800 points |

`salary-targets.csv` carries these bands from AED 4,000 up to AED 14,999. Every salary in the sheet falls between 4,000 and 10,000; bands above that are the same rule carried forward, and a salary outside every band is reported when targets are generated. Each staff member gets the target of their core product only. Accounts have no band in the sheet, so no accounts target is generated.

## Still needed

- Nothing further on incentives: a manager of a mixed team gets one card calculation and one loan calculation, auto loan leaders and managers have no incentive, there is no AUH-specific treatment, and one loan grid applies to every manager (all confirmed).
- The ASM distinction: the salary sheets name nine ASMs (above); confirm who is paid under the manager scheme before changing their role.
- An **IT department account** (role IT) to keep the tab register, and the list of tabs issued (serial, tab number, accessories, network, SIM, Entra ID, registered mobile) to enter or upload.
