
import { getTodaySalesHistory } from "@/lib/actions/sales";
import PosManager from "./pos-manager";
import MobilePosManager from "./MobilePosManager";
import { getProductsData } from "@/lib/actions/products";
import { getAllCustomers } from "@/lib/actions/customers";
import { getOpenJornadaId } from "@/lib/actions/jornada";

export default async function Home(){

    // One parallel batch instead of a sequential waterfall: with the wider
    // Prisma pool these queries overlap on the database instead of each one
    // waiting for the previous round-trip to come back.
    const [rawProducts, sales, rawCustomerList, activeJornadaId] = await Promise.all([
        getProductsData(),
        getTodaySalesHistory(),
        getAllCustomers(),
        getOpenJornadaId(),
    ]);

    // Actions return monetary values as safe integer cents. The JSON wash
    // serializes customer dates; sales already come back serialized.
    const products = JSON.parse(JSON.stringify(rawProducts));
    const customerList = JSON.parse(JSON.stringify(rawCustomerList));

    // Same split as the admin modules: the desktop POS renders from lg up,
    // the dedicated mobile POS below lg. Each owns its layout end to end.
    return(
       <>
           <div className="hidden lg:flex lg:h-full lg:w-full">
               <PosManager products={products} sales={sales} customerList={customerList} jornadaOpen={activeJornadaId !== null} activeJornadaId={activeJornadaId}/>
           </div>

           <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden lg:hidden">
               <MobilePosManager products={products} sales={sales} customerList={customerList} jornadaOpen={activeJornadaId !== null} activeJornadaId={activeJornadaId}/>
           </div>
       </>
    );
}
