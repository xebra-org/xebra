import { DocPage, docMetadata } from "../../components/content/doc-page";

// Read again hourly: the routes and fees it states follow the contracts.
export const revalidate = 3600;

export function generateMetadata() {
  return docMetadata("/routes");
}

export default function Page() {
  return <DocPage path="/routes" navCurrent="/routes" />;
}
