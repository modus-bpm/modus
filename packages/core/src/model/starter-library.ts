// The starter library: one file per template in `templates/` at the root of the repository,
// listed here in the order the gallery shows them (a department's best-known processes first).
// To add one: export it from the Studio's Templates page, put the file in `templates/`, and add
// its line here. A test fails when a file there is missing from this list.

import type { TemplateFile } from './template-files'

import invoiceApproval from '../../../../templates/invoice-approval.json'
import expenseReport from '../../../../templates/expense-report.json'
import travelRequest from '../../../../templates/travel-request.json'
import threeWayMatch from '../../../../templates/three-way-match.json'
import newVendorSetup from '../../../../templates/new-vendor-setup.json'
import vendorBankChange from '../../../../templates/vendor-bank-change.json'
import checkRequest from '../../../../templates/check-request.json'
import refundOrCredit from '../../../../templates/refund-or-credit.json'
import capitalExpenditureRequest from '../../../../templates/capital-expenditure-request.json'
import purchaseRequest from '../../../../templates/purchase-request.json'
import contractReview from '../../../../templates/contract-review.json'
import threeQuotes from '../../../../templates/three-quotes.json'
import softwarePurchase from '../../../../templates/software-purchase.json'
import contractRenewal from '../../../../templates/contract-renewal.json'
import newHireOnboarding from '../../../../templates/new-hire-onboarding.json'
import offboarding from '../../../../templates/offboarding.json'
import timeOffRequest from '../../../../templates/time-off-request.json'
import leaveOfAbsence from '../../../../templates/leave-of-absence.json'
import jobRequisition from '../../../../templates/job-requisition.json'
import trainingRequest from '../../../../templates/training-request.json'
import licenseAndCertificationRenewal from '../../../../templates/license-and-certification-renewal.json'
import serviceDeskTicket from '../../../../templates/service-desk-ticket.json'
import accessRequest from '../../../../templates/access-request.json'
import equipmentRequest from '../../../../templates/equipment-request.json'
import changeRequest from '../../../../templates/change-request.json'
import majorIncident from '../../../../templates/major-incident.json'
import quarterlyAccessReview from '../../../../templates/quarterly-access-review.json'
import securityIncident from '../../../../templates/security-incident.json'
import workOrder from '../../../../templates/work-order.json'
import vehicleRepair from '../../../../templates/vehicle-repair.json'
import preventiveMaintenance from '../../../../templates/preventive-maintenance.json'
import vehicleAccidentReport from '../../../../templates/vehicle-accident-report.json'
import motorPoolReservation from '../../../../templates/motor-pool-reservation.json'
import safetyNearMiss from '../../../../templates/safety-near-miss.json'
import alarmScreening from '../../../../templates/alarm-screening.json'
import publicRecordsRequest from '../../../../templates/public-records-request.json'
import buildingPermitReview from '../../../../templates/building-permit-review.json'
import businessLicenseApplication from '../../../../templates/business-license-application.json'
import codeEnforcementComplaint from '../../../../templates/code-enforcement-complaint.json'
import residentServiceRequest from '../../../../templates/resident-service-request.json'
import specialEventPermit from '../../../../templates/special-event-permit.json'
import councilAgendaItem from '../../../../templates/council-agenda-item.json'
import grantApplicationReview from '../../../../templates/grant-application-review.json'
import incidentReport from '../../../../templates/incident-report.json'
import customerComplaint from '../../../../templates/customer-complaint.json'
import newClientIntake from '../../../../templates/new-client-intake.json'
import discountApproval from '../../../../templates/discount-approval.json'
import correctiveAction from '../../../../templates/corrective-action.json'
import procedureChange from '../../../../templates/procedure-change.json'
import sharedInboxTriage from '../../../../templates/shared-inbox-triage.json'

/** The starter files, in gallery order. Each holds one template. */
export const STARTER_FILES = [
  invoiceApproval,
  expenseReport,
  travelRequest,
  threeWayMatch,
  newVendorSetup,
  vendorBankChange,
  checkRequest,
  refundOrCredit,
  capitalExpenditureRequest,
  purchaseRequest,
  contractReview,
  threeQuotes,
  softwarePurchase,
  contractRenewal,
  newHireOnboarding,
  offboarding,
  timeOffRequest,
  leaveOfAbsence,
  jobRequisition,
  trainingRequest,
  licenseAndCertificationRenewal,
  serviceDeskTicket,
  accessRequest,
  equipmentRequest,
  changeRequest,
  majorIncident,
  quarterlyAccessReview,
  securityIncident,
  workOrder,
  vehicleRepair,
  preventiveMaintenance,
  vehicleAccidentReport,
  motorPoolReservation,
  safetyNearMiss,
  alarmScreening,
  publicRecordsRequest,
  buildingPermitReview,
  businessLicenseApplication,
  codeEnforcementComplaint,
  residentServiceRequest,
  specialEventPermit,
  councilAgendaItem,
  grantApplicationReview,
  incidentReport,
  customerComplaint,
  newClientIntake,
  discountApproval,
  correctiveAction,
  procedureChange,
  sharedInboxTriage,
] as unknown as TemplateFile[]
