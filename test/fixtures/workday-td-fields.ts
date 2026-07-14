// PII-FREE fixture: the FIELD STRUCTURE of a real Workday application (TD Bank tenant), captured as
// the WorkdayAdapter's getFields would enumerate it. Only stable `name`/`id` refs, labels, control
// types, required flags, and step indices — NO personal values of any kind. Used to test the
// Workday question classifier (src/ats/workday-questions.ts) without a browser.
//
// `ref` mirrors the page's stable hook: the Workday `name` for standard fields, the `id` otherwise;
// tenant-specific questions keep their opaque hex `name` as ref but carry the human question text as
// `label` (which is what keys the answer bank).

import type { FormField } from "../../src/ats/adapter";

const f = (
  ref: string,
  label: string,
  controlType: FormField["controlType"],
  step: number,
  required = false
): FormField => ({ ref, label, controlType, required, step });

export const TD_WORKDAY_FIELDS: FormField[] = [
  // --- Step 1: My Information ---
  f("candidateIsPreviousWorker", "Have you ever been employed previously by TD Bank or any of its affiliates, or a company that was acquired by or merged with TD Bank?", "radio_group", 1, true),
  f("country", "Country", "custom_select", 1, true),
  f("legalName--firstName", "First Name", "text", 1, true),
  f("legalName--lastName", "Last Name", "text", 1, true),
  f("preferredCheck", "I have a preferred name", "checkbox", 1),
  f("addressLine1", "Address Line 1", "text", 1),
  f("city", "City", "text", 1),
  f("countryRegion", "State", "custom_select", 1),
  f("postalCode", "Postal Code", "text", 1),
  f("phoneType", "Phone Device Type", "custom_select", 1, true),
  f("phoneNumber--countryPhoneCode", "Country Phone Code", "text", 1, true),
  f("phoneNumber", "Phone Number", "text", 1, true),
  f("extension", "Phone Extension", "text", 1),

  // --- Step 2: My Experience ---
  f("jobTitle", "Job Title", "text", 2, true),
  f("companyName", "Company", "text", 2, true),
  f("location", "Location", "text", 2),
  f("currentlyWorkHere", "I currently work here", "checkbox", 2),
  f("workExperience-48--startDate", "From", "date", 2, true),
  f("workExperience-48--endDate", "To", "date", 2, true),
  f("workExperience-48--roleDescription", "Role Description", "textarea", 2, true),
  f("education-49--school", "School or University", "text", 2, true),
  f("degree", "Degree", "custom_select", 2, true),
  f("education-49--fieldOfStudy", "Field of Study", "text", 2),
  f("language", "Language", "custom_select", 2, true),
  f("native", "I am fluent in this language.", "checkbox", 2),
  f("de7696529635010f30a59173ff0385a1", "Conduct Business", "custom_select", 2, true),
  f("de769652963501aac6f57673ff0384a1", "Overall", "custom_select", 2, true),
  f("de7696529635011c58399473ff0386a1", "Reading", "custom_select", 2, true),
  f("de7696529635014b12cb9673ff0387a1", "Speaking", "custom_select", 2, true),
  f("de769652963501ee55b99973ff0388a1", "Writing", "custom_select", 2, true),
  f("skills--skills", "Type to Add Skills", "typeahead", 2),
  f("resumeAttachments--attachments", "Upload a file (5MB max)", "file_upload", 2, true),
  f("linkedInAccount", "If you would like to share your LinkedIn profile, please include the link here.", "text", 2),

  // --- Step 3: Application Questions (tenant-specific hex names; text identifies them) ---
  f("73a5111f34b31004252a2365c6190000", "A requirement of this position is to have reached the federal age of majority, which is 18 years old. Do you meet this requirement?", "custom_select", 3, true),
  f("73a5111f34b31004252a2365c6190003", "A requirement of this position is to have a Secondary School/High School diploma or equivalent. Do you meet this educational requirement?", "custom_select", 3, true),
  f("73a5111f34b31004252a23ff39e20001", "Are you currently authorized to work in the United States?", "custom_select", 3, true),
  f("73a5111f34b31004252a23ff39e20004", "Will you now, or in the future, require sponsorship for United States employment visa status (e.g. H1-B visa status)?", "custom_select", 3, true),
  f("73a5111f34b31004252a23ff39e20007", "Do you have any relatives or people you share a financial or close personal relationship with, who work at TD Bank or any of its affiliates?", "custom_select", 3, true),
  f("73a5111f34b31004252a2498b5d70000", "Are you party to any agreement (e.g. non-solicitation) that restricts your ability to perform the job you are applying for?", "custom_select", 3, true),
  f("73a5111f34b31004252a2498b5d70004", "During the past two (2) years, have you been employed by a federal or state government banking agency, or the equivalent in another country?", "custom_select", 3, true),
  f("73a5111f34b31004252a25cbb5730001", "Are you, or anyone you have a close personal or financial relationship with, a politically exposed person?", "custom_select", 3, true),
  f("empType-73a5111f34b31004252a25cbb5730005", "What type of employment are you seeking? (select all that apply)", "multi_checkbox", 3, true),
  f("primaryQuestionnaire--73a5111f34b31004252a266562b10003", "Please indicate your expected number of weekly hours:", "text", 3),
  f("primaryQuestionnaire--73a5111f34b31004252a266562b10004", "Compensation Expectations", "textarea", 3),

  // --- Step 4: Voluntary Disclosures ---
  f("gender", "Sex:", "custom_select", 4, true),
  f("ethnicity", "Race/Ethnicity:", "custom_select", 4, true),
  f("veteranStatus", "Veteran Status:", "custom_select", 4, true),
  f("acceptTermsAndAgreements", "I willingly accept the Terms and Conditions for submitting an application with TD.", "checkbox", 4, true),

  // --- Step 5: Self Identify (CC-305 disability form) ---
  f("disabilityForm", "Language", "custom_select", 5),
  f("name", "Name", "text", 5, true),
  f("employeeId", "Employee ID (if applicable)", "text", 5),
  f("selfIdentifiedDisabilityData--dateSignedOn", "Date", "date", 5, true),
  f("64cbff5f364f10000ae7a421cf210000-disabilityStatus", "Please check one of the boxes below (disability status)", "multi_checkbox", 5, true),
];
