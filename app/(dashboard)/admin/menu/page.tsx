import { getSuppliesData } from "@/lib/actions/inventory";
import { getProductPage } from "@/lib/actions/products";
import { MenuManager } from "./menu-manager";
import { MobileMenuManager } from "./MobileMenuManager";

export default async function Home() {

    const [raw, products] = await Promise.all([getSuppliesData(), getProductPage()]);

    const data = JSON.parse(JSON.stringify(raw))


    return (
        <>
            <div className="hidden md:flex h-full w-full">
                <MenuManager supplies={data} products={products}/>
            </div>

            <div className="flex md:hidden h-full w-full">
                <MobileMenuManager supplies={data} products={products}/>
            </div>
        </>
    );
}
