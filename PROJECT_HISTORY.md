\# PROJECT HISTORY



\## Main Objective



Build an autonomous AI operating system for Elevate Recruitment \& Staffing.



The system should connect and validate:

\- Make.com

\- RecruitCRM

\- GitHub

\- Netlify

\- Claude Code

\- APIs and webhooks



\## Current Priority



Validate the Make.com to RecruitCRM workflow.



The workflow must confirm:

\- company profiles are created correctly

\- contact/candidate profiles are created correctly

\- all fields map properly

\- duplicates are prevented

\- webhook payloads are correct

\- errors are detected and fixed

\- deployments are handled through GitHub and Netlify



\## Claude Rules



Claude should:

\- read CLAUDE.md first

\- read PROJECT\_HISTORY.md

\- read SESSION\_HANDOFF.md

\- read SCRIBE\_EXPORT.md

\- troubleshoot independently

\- not ask Travis to manually edit files

\- not ask Travis to manually upload HTML

\- not ask Travis to manually push GitHub

\- not ask Travis to manually deploy Netlify

\- use terminal, GitHub CLI, Netlify CLI, APIs, and repo files

\- document everything it learns



\## Known Systems



\- RecruitCRM is the CRM/ATS

\- Make.com handles automations

\- GitHub stores the repo

\- Netlify deploys the project

\- Claude Code works inside the local project folder



\## RecruitCRM API Notes



The RecruitCRM system uses:

\- contacts endpoints

\- companies endpoints

\- candidate endpoints

\- notes endpoints

\- sequences/enrollment endpoints



Important operational behaviors:

\- company\_slug is critical for linking records

\- duplicate prevention must happen before creating companies or contacts

\- custom\_fields mappings are important

\- webhook payload validation is required

\- Make.com flows should be audited for mapping issues and failed requests



\## Workflow Expectations



Claude should:

\- inspect existing mappings

\- inspect Make.com workflows

\- compare payloads against RecruitCRM API requirements

\- verify end-to-end automation success

\- test safely where possible

\- document assumptions and fixes

\- continuously improve reliability

