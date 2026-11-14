# Starter templates

Modus ships with 50 workflow templates, grouped by department. Each one is a small process you can
look at, start a new application from, or add to an application you already have. Open **Templates** in the
Studio to browse them, filter by department or tag, and search by the name you use at work.

Each template has its own page, linked from its name below: a picture of its map as the designer draws
it, what every step does and where its paths lead, and the fields it brings.

Every template is a starting point. The thresholds, deadlines and waits are examples: change them to
your own. People steps arrive without a group, because who does the work is yours to say. Automated
steps marked *your system* call nothing until you point them at a service of your own; until then the
step simply takes its time and passes the item on.

## Templates are files

A template is a JSON file. The fifty here are the files in [`templates/`](../templates) at the root of the
repository, and a template you save yourself becomes the same kind of file when you export it.

- **Export.** On the Templates page, the download button on a card saves that template to a file. **Export
  all** saves the whole library to one file, or just what your search and filters show.
- **Import.** **Import…** takes one file or several. A template your library already has (the same id) is
  kept beside yours as a copy, replaces yours, or is skipped: you choose. A file that is not a template file,
  or a template with a step or path missing, is refused with the reason.
- **Your copy stays yours.** A library keeps the templates it has. Upgrading Modus does not change them, so
  what you tweaked stays tweaked; to take a newer starter template, import its file.

On a server, importing changes the design like any other edit: save it and every replica has the templates.

## Finance and AP

| Template | What happens | Steps | Your systems |
| --- | --- | --- | --- |
| [**Invoice approval**](templates/invoice-approval.md) | A clerk codes the invoice, then the amount decides who approves: a manager under $5,000, a department head above that, and the controller as well over $25,000. | 7 | 1 |
| [**Expense report**](templates/expense-report.md) | The employee’s own manager reviews it and can send it back for changes. Reports over $1,000 also go to finance before reimbursement. | 5 | 1 |
| [**Travel request**](templates/travel-request.md) | The traveler’s manager approves. International trips and trips over $3,000 also go to finance before the travel desk books anything. | 4 |  |
| [**Three-way match**](templates/three-way-match.md) | Fetch the purchase order and the goods receipt in parallel, then match them against the invoice. Only mismatches go to a person. The two fetch steps call the sample ERP: point them at your own purchasing system. | 6 |  |
| [**New vendor setup**](templates/new-vendor-setup.md) | Accounts payable checks the paperwork and waits for anything missing. Tax, insurance and bank details are then checked at the same time, and the controller signs off before the vendor can be paid. | 9 | 1 |
| [**Vendor bank change**](templates/vendor-bank-change.md) | A request to change a vendor’s bank details is confirmed by a call-back to the number already on file, made by someone other than the person who took the request, before the controller approves it. | 4 | 1 |
| [**Check request**](templates/check-request.md) | A payment outside the normal invoice run goes to three authorized signers at once and is released as soon as any two have signed. One refusal stops it. | 7 | 1 |
| [**Refund or credit**](templates/refund-or-credit.md) | Customer service checks the request. Refunds of $250 or less are issued straight away; larger ones need a manager first. | 4 | 1 |
| [**Capital expenditure request**](templates/capital-expenditure-request.md) | Finance and operations review the business case at the same time. The department head decides requests up to $100,000; anything larger goes to an executive. | 7 |  |

## Purchasing and contracts

| Template | What happens | Steps | Your systems |
| --- | --- | --- | --- |
| [**Purchase request**](templates/purchase-request.md) | A manager approves the request; anything over $10,000 also needs a director. Ends as Approved or Rejected. | 3 |  |
| [**Contract review**](templates/contract-review.md) | Legal and compliance review the contract at the same time. Both must approve before final sign-off; a rejection from either stops the other. | 5 |  |
| [**Three quotes**](templates/three-quotes.md) | Three suppliers are asked for a quote at the same time. The buyer compares as soon as two have answered, and the third is no longer waited for. | 7 | 1 |
| [**Software purchase**](templates/software-purchase.md) | Security, legal and budget look at a new tool at the same time, so the request waits on the slowest of the three and not on all of them in turn. The IT owner approves once all three agree. | 7 | 1 |
| [**Contract renewal**](templates/contract-renewal.md) | A timer wakes the contract’s owner ahead of the end date. They renew it, renegotiate it or let it end, and it escalates if they have not decided within three days. | 5 |  |

## People and HR

| Template | What happens | Steps | Your systems |
| --- | --- | --- | --- |
| [**New hire onboarding**](templates/new-hire-onboarding.md) | Accounts are created automatically while IT, Facilities and Payroll work in parallel; the hiring manager welcomes the new hire once everything is ready. | 7 |  |
| [**Offboarding**](templates/offboarding.md) | When someone leaves, access removal, equipment return, final pay and the handover all start at once. HR closes the file only when every one of them is done. | 7 | 1 |
| [**Time-off request**](templates/time-off-request.md) | The request goes to the employee’s own manager. If nobody has answered in 48 hours it is escalated; once approved, the team calendar is updated. | 2 | 1 |
| [**Leave of absence**](templates/leave-of-absence.md) | HR checks eligibility and can ask the employee for documents. The leave then waits until the return date, when HR either confirms the return or extends it. | 5 |  |
| [**Job requisition**](templates/job-requisition.md) | Finance checks the budget while HR checks the grade and the posting. A replacement can then be posted; a new position needs an executive first. | 7 | 1 |
| [**Training request**](templates/training-request.md) | The employee’s manager approves; courses over $1,500 also go to HR. After the course the employee confirms they finished it, so the record is complete. | 6 | 1 |
| [**License and certification renewal**](templates/license-and-certification-renewal.md) | A timer starts the renewal ahead of the expiry date. The employee uploads proof, HR verifies it or sends it back, and it escalates if the date is getting close. | 4 | 1 |

## IT and security

| Template | What happens | Steps | Your systems |
| --- | --- | --- | --- |
| [**Service desk ticket**](templates/service-desk-ticket.md) | An AI agent sorts each ticket. Sure ones go straight to the service desk queue; the rest are sorted by a person first. The desk resolves it, asks for more information, or passes it to a specialist. | 6 |  |
| [**Access request**](templates/access-request.md) | The person’s manager approves, then the system’s owner, who can ask the requester for more information. Access is granted only after both say yes. | 4 | 1 |
| [**Equipment request**](templates/equipment-request.md) | After the manager approves, IT checks stock. What is on the shelf is handed over the same day; anything else is ordered and waits for delivery first. | 6 |  |
| [**Change request**](templates/change-request.md) | An emergency change goes to one emergency approver. Every other change goes to five board members at once and proceeds when three have approved; an objection sends it back. | 10 |  |
| [**Major incident**](templates/major-incident.md) | The first on-call engineer to claim it leads. Restoring service and keeping people informed run side by side against a four-hour clock that escalates at two, and a review follows. | 6 |  |
| [**Quarterly access review**](templates/quarterly-access-review.md) | Each manager confirms who still needs access. A 14-day timer runs beside the review: if the manager has not answered when it ends, the access is removed. | 5 | 2 |
| [**Security incident**](templates/security-incident.md) | An analyst confirms the report or closes it as a false alarm. Containing it and preserving evidence then run at the same time, and legal is brought in only when personal data is involved. | 8 |  |

## Facilities, fleet and safety

| Template | What happens | Steps | Your systems |
| --- | --- | --- | --- |
| [**Work order**](templates/work-order.md) | Emergencies go straight to the on-call technician. Routine work is handed out by a dispatcher, can wait on parts, and closes only when the person who asked confirms it is fixed. | 5 |  |
| [**Vehicle repair**](templates/vehicle-repair.md) | A mechanic inspects and estimates. Repairs over $1,500 need the fleet manager, who can decide the vehicle is not worth repairing. A road test releases it back into service. | 6 |  |
| [**Preventive maintenance**](templates/preventive-maintenance.md) | A schedule opens the job and a dispatcher hands it to a technician. If the checklist turns up a problem, a supervisor decides whether to repair now or defer it, and the service is recorded either way. | 5 | 1 |
| [**Vehicle accident report**](templates/vehicle-accident-report.md) | The driver named on the report writes the statement. The insurance claim, the repair estimate and the safety review then run at the same time before the fleet manager closes it. | 7 |  |
| [**Motor pool reservation**](templates/motor-pool-reservation.md) | The motor pool approves and assigns a vehicle. The reservation then waits until the vehicle is due back, and a check-in inspection logs any damage before it closes. | 5 |  |
| [**Safety near-miss**](templates/safety-near-miss.md) | The first safety lead to pick it up decides whether action is needed. A task is handed out, verified, and sent back if the hazard is still there; then what was learned is shared. | 4 |  |
| [**Alarm screening**](templates/alarm-screening.md) | An AI agent screens every alarm and dismisses the ones it is sure are false. An operator verifies the rest and the responder is told only about real ones. | 5 |  |

## Government and public safety

| Template | What happens | Steps | Your systems |
| --- | --- | --- | --- |
| [**Public records request**](templates/public-records-request.md) | The clerk logs the request and can pause it while the requester clarifies. Departments search at the same time, legal reviews for exemptions, and the response goes out. Set the deadline your own law gives you. | 8 |  |
| [**Building permit review**](templates/building-permit-review.md) | After a completeness check, zoning, fire and engineering review the plans at the same time. The building official then issues the permit, denies it, or sends the plans back to the applicant for corrections and another round. | 10 | 1 |
| [**Business license application**](templates/business-license-application.md) | The clerk checks the application and sends incomplete ones back. A zoning check decides whether the business is allowed at that address; if it is, the fee is collected and the license issued. | 7 | 1 |
| [**Code enforcement complaint**](templates/code-enforcement-complaint.md) | An officer inspects. If there is a violation, a notice goes out and the case waits 30 days; a re-inspection then closes it or leads to a citation. | 6 |  |
| [**Resident service request**](templates/resident-service-request.md) | An AI agent picks the department for each request; a clerk routes the ones it is unsure of. A dispatcher hands the job to a crew, and the resident is told when it is done. | 5 |  |
| [**Special event permit**](templates/special-event-permit.md) | The clerk checks the application and the insurance certificate. Police, fire and public works sign off at the same time, and events expecting more than 1,000 people also need the manager. | 10 | 1 |
| [**Council agenda item**](templates/council-agenda-item.md) | The department head forwards the item, legal and finance review it at the same time, and the manager approves it or returns it to the department before the clerk places it on the agenda. | 7 |  |
| [**Grant application review**](templates/grant-application-review.md) | After an eligibility check, three reviewers score the application independently. The panel decides as soon as two scores are in, and funded applicants get an award letter. | 8 |  |
| [**Incident report**](templates/incident-report.md) | The person who handled the incident writes it up (retain familiar), a commander reviews, and it is filed to records automatically. | 3 |  |

## Customers and operations

| Template | What happens | Steps | Your systems |
| --- | --- | --- | --- |
| [**Customer complaint**](templates/customer-complaint.md) | A draft reply is prepared automatically and a person always reviews it before anything is sent. Hard cases go to a manager, and a follow-up three days later reopens it if the customer is still unhappy. | 5 | 1 |
| [**New client intake**](templates/new-client-intake.md) | A conflict and credit check comes first. Then the engagement letter, billing setup and the kickoff all start together, and the client is active once the three are done. | 6 |  |
| [**Discount approval**](templates/discount-approval.md) | The size of the discount decides who signs: up to 10% is approved automatically, up to 20% needs the sales manager, and anything more goes to a director. | 4 | 1 |
| [**Corrective action**](templates/corrective-action.md) | Find the root cause, get the plan approved, and carry it out. Thirty days later someone checks whether it worked; if it did not, the case goes back to the root cause. | 5 |  |
| [**Procedure change**](templates/procedure-change.md) | Operations and quality review the draft at the same time. The process owner approves it or sends it back to the author; once approved it is published and team leads acknowledge it. | 8 |  |
| [**Shared inbox triage**](templates/shared-inbox-triage.md) | An AI agent classifies each message that arrives. Confident answers go straight through; the rest go to a person, whose corrections are recorded. | 3 |  |

## How they were chosen

The list aims at the processes most organizations of a few hundred to a few thousand people run, named the
way the people who own them name them, with more than the usual share for local government, where general
template galleries have little. Processes whose steps are set by law or that depend on an integration Modus
does not have were left out on purpose.

Every template is checked by the test suite: its file reads back as written, it has no unreachable step and no outcome without a path, an
application started from it runs sample items to an end, and the designer's own check asks for nothing
except who does the work.
