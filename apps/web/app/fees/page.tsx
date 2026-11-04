import { DocPage, docMetadata } from "../../components/content/doc-page";

// Read again hourly: the routes and fees it states follow the contracts.
export const revalidate = 3600;

export function generateMetadata() {
  return docMetadata("/fees");
}

export default function Page() {
  return <DocPage path="/fees" navCurrent="/fees" />;
}
