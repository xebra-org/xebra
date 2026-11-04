import { DocPage, docMetadata } from "../../components/content/doc-page";

// Read again hourly: the routes and fees it states follow the contracts.
export const revalidate = 3600;

export function generateMetadata() {
  return docMetadata("/how-it-works");
}

export default function Page() {
  return <DocPage path="/how-it-works" navCurrent="/how-it-works" />;
}
