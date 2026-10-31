// Fill these in from Supabase -> Project Settings -> API.
// The anon key is meant to be public; your data is protected by the
// row-level security rules in schema.sql.
const CONFIG = {
  SUPABASE_URL: "https://vogexdlqfjdwnsmwdcqf.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZvZ2V4ZGxxZmpkd25zbXdkY3FmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4NDYxMzAsImV4cCI6MjEwNjQyMjEzMH0.nTpU2r9YAYDFgYV1uEGjYbLkAzv_cRQH6J739tQVfB8",

  // Shown before every price. Change to your campus currency (e.g. "MK ", "KSh ", "$").
  CURRENCY: "MK",

  // Optional: only allow sign-ups from your campus email domain, e.g. "student.biu.edu".
  // Leave "" to allow any email. (This is a friendly check only; to enforce it
  // properly, also restrict sign-ups on the Supabase side.)
  ALLOWED_EMAIL_DOMAIN: "",

  // Schools students can choose at sign-up. Each listing belongs to its seller's school.
  // Add or remove names freely (keep spelling consistent once people have signed up).
  SCHOOLS: [
    "Blantyre International University (BIU)",
    "University of Malawi (UNIMA)",
    "Malawi University of Business and Applied Sciences (MUBAS)",
    "Malawi University of Science and Technology (MUST)",
    "Lilongwe University of Agriculture and Natural Resources (LUANAR)",
    "Mzuzu University (MZUNI)",
    "Kamuzu University of Health Sciences (KUHeS)",
    "Catholic University of Malawi (CUNIMA)",
    "Malawi Adventist University",
    "DMI St John the Baptist University",
    "University of Livingstonia",
    "Nkhoma University",
    "Exploits University",
    "Malawi Assemblies of God University (MAGU)",
    "Daeyang University",
    "Skyway University",
    "Other",
  ],
};
