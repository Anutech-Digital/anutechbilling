/**
 * Solo Freelancer & Independent Professional Quick Service Templates.
 *
 * Pre-configured professional service packages for freelancers, web developers,
 * UI/UX designers, and tech consultants using ResellerOS Solo Free Forever tier.
 */

export interface FreelancerServiceTemplate {
  id: string;
  name: string;
  category: "Development" | "Design" | "Marketing" | "Consulting" | "Maintenance";
  description: string;
  suggestedRate: number; // in whole rupees
  hsnSac: string;
  defaultQty: number;
}

export const FREELANCER_SERVICE_TEMPLATES: readonly FreelancerServiceTemplate[] = [
  {
    id: "solo-web-dev",
    name: "Website UI/UX Design & Frontend Development",
    category: "Development",
    description: "Responsive website design, modern React/Next.js UI, mobile optimization, and deployment.",
    suggestedRate: 25000,
    hsnSac: "998314",
    defaultQty: 1,
  },
  {
    id: "solo-fullstack-mvp",
    name: "Full-Stack Web App / MVP Development",
    category: "Development",
    description: "End-to-end web application with database, authentication, backend API, and responsive dashboard.",
    suggestedRate: 45000,
    hsnSac: "998314",
    defaultQty: 1,
  },
  {
    id: "solo-seo-retainer",
    name: "Monthly SEO, Content & Organic Growth Retainer",
    category: "Marketing",
    description: "Technical SEO audit, keyword optimization, Google Search Console tracking, and monthly growth report.",
    suggestedRate: 15000,
    hsnSac: "998315",
    defaultQty: 1,
  },
  {
    id: "solo-tech-consulting",
    name: "Technical Architecture & Code Review Consulting",
    category: "Consulting",
    description: "Architecture roadmap, database schema design, performance audit, and senior developer consultation.",
    suggestedRate: 20000,
    hsnSac: "998313",
    defaultQty: 1,
  },
  {
    id: "solo-maintenance-devops",
    name: "Website Maintenance, Security & Cloud Support",
    category: "Maintenance",
    description: "Regular backups, SSL renewal, security patches, bug fixes, and cloud uptime monitoring.",
    suggestedRate: 8000,
    hsnSac: "998316",
    defaultQty: 1,
  },
  {
    id: "solo-branding-kit",
    name: "Brand Identity, Logo & Social Media Kit",
    category: "Design",
    description: "Vector logo files, typography palette, brand guidelines, and social media header kit.",
    suggestedRate: 12000,
    hsnSac: "998314",
    defaultQty: 1,
  },
  {
    id: "solo-api-integration",
    name: "Custom API & Payment Gateway Integration",
    category: "Development",
    description: "Razorpay / Stripe webhook wiring, CRM sync, third-party REST API integration and automated tests.",
    suggestedRate: 18000,
    hsnSac: "998313",
    defaultQty: 1,
  },
  {
    id: "solo-mobile-ui",
    name: "Mobile App UI Design & Interactive Prototype",
    category: "Design",
    description: "Figma design system, high-fidelity clickable prototype, user flows, and asset handoff.",
    suggestedRate: 35000,
    hsnSac: "998314",
    defaultQty: 1,
  },
] as const;
