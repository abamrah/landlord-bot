/**
 * Provincial / regional tenancy law profiles.
 * Used by the AI agent to tailor drafts to the landlord's jurisdiction.
 */
export type RtaProfile = {
    name: string;
    legislation: string;
    noticePeriodsEntry: string;
    emergencyRepairMaxHours: number;
    rentIncreaseRules: string;
    disputeBody: string;
    promptAddendum: string;
};

export const RTA_PROFILES: Record<string, RtaProfile> = {
    ON: {
        name: "Ontario",
        legislation: "Residential Tenancies Act, 2006 (Ontario)",
        noticePeriodsEntry: "24 hours written notice",
        emergencyRepairMaxHours: 24,
        rentIncreaseRules: "Max once per 12 months, guideline increase only unless AGI approved. N1 notice 90 days prior.",
        disputeBody: "Landlord and Tenant Board (LTB)",
        promptAddendum: `You must comply with Ontario's Residential Tenancies Act, 2006. The Landlord and Tenant Board (LTB) handles all disputes. Rent increases require N1 notice 90 days prior. Entry requires 24-hour written notice except emergencies.

=== BRAMPTON RESIDENTIAL RENTAL LICENSING (RRL) ===
Brampton's Residential Rental Licensing Bylaw 261-2019 requires ALL landlords renting residential units within the City of Brampton to:
• Register each rental unit with the City and obtain a Rental Licence (annual renewal)
• Pay the applicable licence fee (varies by unit type; typically ~$250–$400/unit/year)
• Ensure units meet all Property Standards, Fire Code, and Building Code requirements
• Allow municipal inspectors to conduct initial and periodic inspections of each licensed unit
• Display the licence or provide the licence number to tenants upon request
• Maintain units in a state of good repair as defined by the Ontario Building Code and City property standards
• Comply with occupancy limits set by the Ontario Building Code (no more than 2 persons per habitable room excluding kitchen/living/dining)
• Report changes in tenancy or unit status within 30 days
Penalties for non-compliance: Fines up to $25,000 for a first offence and $50,000 for subsequent offences. Operating without a licence can result in order to comply, prosecution, or licence revocation.
Licence Application: Apply through the City of Brampton's online portal or in-person at City Hall. Processing typically takes 4–6 weeks. Inspections scheduled upon application.

=== ONTARIO BILL 60 — HOMEOWNER PROTECTION ACT, 2024 ===
Bill 60 (Homeowner Protection Act) is Ontario legislation addressing homeowner and landlord protections:
• Strengthens penalties for illegal evictions (fines up to $100,000 for individuals, $500,000 for corporations)
• Clarifies landlord obligations for maintenance, habitability, and timely repairs
• Introduces requirements for landlords to provide written notice of tenant rights at lease signing
• Expands tenant remedies at the LTB for bad-faith evictions (N12/N13 misuse)
• Requires landlords acting on N12 notices (landlord's own use) to provide evidence of genuine intent
• Establishes a public database of landlords found guilty of bad-faith evictions
• Strengthens the Rental Housing Enforcement Unit (RHEU) powers for investigation
Study Guide Key Points:
1. Bad-faith N12: If landlord does not move in within reasonable time, tenant can seek up to 12 months' rent as compensation
2. Documentation: Keep all records — notices, communications, inspection reports — for at least 3 years
3. Tenant notification: At lease signing, provide a standardized information sheet about tenant rights under the RTA
4. Compliance: Failure to comply with Bill 60 provisions may result in Administrative Monetary Penalties (AMPs) in addition to LTB orders`,
    },
    BC: {
        name: "British Columbia",
        legislation: "Residential Tenancy Act (BC)",
        noticePeriodsEntry: "24 hours with written notice",
        emergencyRepairMaxHours: 24,
        rentIncreaseRules: "Max once per 12 months, government-set maximum percentage. 3 months notice required.",
        disputeBody: "Residential Tenancy Branch (RTB)",
        promptAddendum: `You must comply with BC's Residential Tenancy Act. The Residential Tenancy Branch (RTB) handles disputes. Rent increases require 3 months written notice at the government-approved rate.`,
    },
    AB: {
        name: "Alberta",
        legislation: "Residential Tenancies Act (Alberta)",
        noticePeriodsEntry: "24 hours written notice",
        emergencyRepairMaxHours: 48,
        rentIncreaseRules: "No rent control on most units, but proper notice (3 months periodic, or at renewal for fixed-term) is required.",
        disputeBody: "Residential Tenancy Dispute Resolution Service (RTDRS)",
        promptAddendum: `You must comply with Alberta's Residential Tenancies Act. RTDRS handles disputes. No rent control in Alberta but landlords must give proper notice (3 months for periodic, at renewal for fixed-term).`,
    },
    SK: {
        name: "Saskatchewan",
        legislation: "Residential Tenancies Act, 2006 (Saskatchewan)",
        noticePeriodsEntry: "24 hours written notice",
        emergencyRepairMaxHours: 48,
        rentIncreaseRules: "No rent control. Requires written notice (at least 1 year from lease start or last increase, 6 months notice for periodic tenancies).",
        disputeBody: "Office of Residential Tenancies (ORT)",
        promptAddendum: `You must comply with Saskatchewan's Residential Tenancies Act. The ORT handles disputes.`,
    },
    MB: {
        name: "Manitoba",
        legislation: "Residential Tenancies Act (Manitoba)",
        noticePeriodsEntry: "24 hours written notice",
        emergencyRepairMaxHours: 24,
        rentIncreaseRules: "Rent increases limited to government guideline. Requires 3 months notice.",
        disputeBody: "Residential Tenancies Branch (RTB)",
        promptAddendum: `You must comply with Manitoba's Residential Tenancies Act. The RTB handles disputes. Rent increases are capped at the government guideline.`,
    },
    QC: {
        name: "Quebec",
        legislation: "Civil Code of Quebec & Tribunal administratif du logement",
        noticePeriodsEntry: "24 hours notice (except emergencies)",
        emergencyRepairMaxHours: 24,
        rentIncreaseRules: "Landlord proposes increase 3-6 months before renewal. Tenant may refuse; TAL decides if disputed.",
        disputeBody: "Tribunal administratif du logement (TAL)",
        promptAddendum: `You must comply with Quebec's Civil Code and the Tribunal administratif du logement (TAL) rules. Rent increases must be proposed 3-6 months before lease renewal.`,
    },
    NS: {
        name: "Nova Scotia",
        legislation: "Residential Tenancies Act (Nova Scotia)",
        noticePeriodsEntry: "24 hours written notice",
        emergencyRepairMaxHours: 24,
        rentIncreaseRules: "Rent cap (currently 5% or CPI). Requires 4 months notice.",
        disputeBody: "Residential Tenancies Program",
        promptAddendum: `You must comply with Nova Scotia's Residential Tenancies Act. Rent increases are capped and require 4 months notice.`,
    },
    NB: {
        name: "New Brunswick",
        legislation: "Residential Tenancies Act (New Brunswick)",
        noticePeriodsEntry: "24 hours notice",
        emergencyRepairMaxHours: 48,
        rentIncreaseRules: "No rent control. Requires 6 months notice for yearly tenancies.",
        disputeBody: "Residential Tenancies Tribunal",
        promptAddendum: `You must comply with New Brunswick's Residential Tenancies Act. No rent control applies.`,
    },
    // US states — common ones
    NY: {
        name: "New York",
        legislation: "NY Real Property Law; NYC Rent Stabilization Code (if applicable)",
        noticePeriodsEntry: "Reasonable notice (typically 24 hours)",
        emergencyRepairMaxHours: 24,
        rentIncreaseRules: "Varies: rent-stabilized units have Rent Guidelines Board increases. Market-rate units have no cap but require 30-90 days notice depending on tenancy length.",
        disputeBody: "NY Housing Court",
        promptAddendum: `You must comply with New York's Real Property Law. For rent-stabilized units, follow the Rent Guidelines Board limits. For market-rate, provide 30-90 day notice depending on tenancy length.`,
    },
    CA_US: {
        name: "California",
        legislation: "California Civil Code; Tenant Protection Act (AB 1482)",
        noticePeriodsEntry: "24 hours written notice (48 hours for inspections)",
        emergencyRepairMaxHours: 24,
        rentIncreaseRules: "AB 1482 caps increases at 5% + CPI (max 10%) for covered units. 30-day notice for increases <10%, 90-day for ≥10%.",
        disputeBody: "California Superior Court, Civil Division",
        promptAddendum: `You must comply with California's Tenant Protection Act (AB 1482) for covered units. Rent increases are capped at 5% + local CPI (max 10%). Provide 30 days notice for <10% and 90 days for ≥10%.`,
    },
    TX: {
        name: "Texas",
        legislation: "Texas Property Code",
        noticePeriodsEntry: "No general statutory requirement (lease governs; emergencies excepted)",
        emergencyRepairMaxHours: 168,
        rentIncreaseRules: "No rent control. Increases governed by lease terms.",
        disputeBody: "Justice Court",
        promptAddendum: `You must comply with Texas Property Code. Texas has no rent control. Entry notice and increase rules are governed by the lease agreement.`,
    },
    UK: {
        name: "United Kingdom (England)",
        legislation: "Housing Act 1988; Renters' Reform Bill (if enacted)",
        noticePeriodsEntry: "24 hours written notice (minimum, tenant agreement preferred)",
        emergencyRepairMaxHours: 24,
        rentIncreaseRules: "Section 13 notice, once per year, at market rate. Tenant can challenge at Tribunal.",
        disputeBody: "First-tier Tribunal (Property Chamber)",
        promptAddendum: `You must comply with the Housing Act 1988. Use Section 13 for rent increases (once per year). Give at least one month's notice for periodic tenancies.`,
    },
};

export function getProfile(code: string): RtaProfile {
    return RTA_PROFILES[code.toUpperCase()] || RTA_PROFILES.ON;
}

export function listProvinces(): { code: string; name: string }[] {
    return Object.entries(RTA_PROFILES).map(([code, profile]) => ({
        code,
        name: profile.name,
    }));
}
